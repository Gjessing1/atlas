package io.gjessing.atlas.packdownload

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.ForegroundInfo
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Downloads the files of one offline map pack into its staging directory.
 *
 * This is only the network half of installing a pack: JS owns the manifest,
 * digest verification, unzipping and the atomic swap into place (see
 * `src/regions/packs.ts`). The bytes are what takes minutes and what the user
 * loses by switching apps, so exactly that part runs here — as WorkManager work
 * under a foreground service, which survives leaving Atlas, and is rescheduled
 * by the system after a process death or a network loss. Every file is written
 * with an HTTP range request from whatever is already on disk, so a resumed
 * download continues instead of starting over.
 */
class PackDownloadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

  private class PackFile(val url: String, val path: String, val bytes: Long)

  /** Progress reports are throttled to this, so a fast link doesn't flood the DB. */
  private var lastReportMs = 0L
  private var lastNotifiedPercent = -1

  override fun doWork(): Result {
    val raw = inputData.getString(KEY_SPEC) ?: return fail("missing download spec")
    val name: String
    val dir: File
    val files = mutableListOf<PackFile>()
    try {
      val spec = JSONObject(raw)
      name = spec.optString("name", "map pack")
      val path = spec.getString("dir")
      if (path.isEmpty()) return fail("unreadable download spec")
      dir = File(path)
      val array = spec.getJSONArray("files")
      for (index in 0 until array.length()) {
        val entry = array.getJSONObject(index)
        files.add(PackFile(entry.getString("url"), entry.getString("path"), entry.getLong("bytes")))
      }
    } catch (err: Exception) {
      return fail("unreadable download spec")
    }
    if (files.isEmpty()) return Result.success()

    val total = files.sumOf { it.bytes }
    var done = 0L
    notify(name, done, total)

    for (file in files) {
      if (isStopped) return Result.success() // cancelled/rescheduled — partials are resumable
      val target = File(dir, file.path)
      target.parentFile?.mkdirs()
      var have = if (target.isFile) target.length() else 0L
      if (have > file.bytes) {
        // Left over from another pack version — not a resumable prefix.
        target.delete()
        have = 0L
      }
      if (have == file.bytes) {
        done += file.bytes
        report(name, done, total, force = true)
        continue
      }
      val at = done
      try {
        transfer(file, target, have) { written -> report(name, at + written, total) }
      } catch (err: IOException) {
        return retryOrFail("${file.path}: ${err.message ?: "download failed"}")
      }
      if (isStopped) return Result.success()
      if (target.length() != file.bytes) {
        // A proxy that ignored the range header, a truncated body: throw the
        // partial away so the retry starts this file from scratch.
        target.delete()
        return retryOrFail("${file.path}: incomplete download")
      }
      done += file.bytes
      report(name, done, total, force = true)
    }
    return Result.success()
  }

  /**
   * Stream one file to disk, appending from `have` bytes with a range request.
   * A server that answers 200 to a ranged request ignored it, so the file is
   * rewritten from the start rather than being appended to (which would corrupt
   * it). Reports bytes written for this file, not the whole pack.
   */
  private fun transfer(file: PackFile, target: File, have: Long, onBytes: (Long) -> Unit) {
    val connection = URL(file.url).openConnection() as HttpURLConnection
    connection.connectTimeout = CONNECT_TIMEOUT_MS
    connection.readTimeout = READ_TIMEOUT_MS
    if (have > 0) connection.setRequestProperty("Range", "bytes=$have-")
    try {
      val status = connection.responseCode
      val resuming =
        when {
          status == HTTP_PARTIAL -> true
          status == HttpURLConnection.HTTP_OK -> false
          else -> throw IOException("HTTP $status")
        }
      val from = if (resuming) have else 0L
      var written = from
      RandomAccessFile(target, "rw").use { out ->
        if (from == 0L) out.setLength(0)
        out.seek(from)
        connection.inputStream.use { input ->
          val buffer = ByteArray(BUFFER_BYTES)
          while (true) {
            if (isStopped) return
            val read = input.read(buffer)
            if (read <= 0) break
            out.write(buffer, 0, read)
            written += read
            onBytes(written)
          }
        }
      }
    } finally {
      connection.disconnect()
    }
  }

  /**
   * A failed attempt is retried with WorkManager's backoff — a flaky link or a
   * server hiccup mid-download is normal and the partial file is kept. Only a
   * run of failures becomes a real failure the UI reports.
   */
  private fun retryOrFail(message: String): Result =
    if (runAttemptCount + 1 < MAX_ATTEMPTS) Result.retry() else fail(message)

  private fun fail(message: String): Result = Result.failure(workDataOf(KEY_ERROR to message))

  private fun report(name: String, done: Long, total: Long, force: Boolean = false) {
    val now = System.currentTimeMillis()
    if (!force && now - lastReportMs < REPORT_INTERVAL_MS) return
    lastReportMs = now
    setProgressAsync(workDataOf(KEY_DONE to done, KEY_TOTAL to total))
    notify(name, done, total)
  }

  /** Keep the work in the foreground so leaving Atlas doesn't freeze the download. */
  private fun notify(name: String, done: Long, total: Long) {
    val percent = if (total <= 0) 0 else ((done * 100) / total).toInt()
    if (percent == lastNotifiedPercent) return
    lastNotifiedPercent = percent
    val manager =
      applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Offline maps", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Progress while an offline map region downloads"
          setShowBadge(false)
        }
      )
    }
    val open =
      applicationContext.packageManager
        .getLaunchIntentForPackage(applicationContext.packageName)
        ?.let {
          PendingIntent.getActivity(
            applicationContext,
            0,
            it,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
          )
        }
    val notification =
      NotificationCompat.Builder(applicationContext, CHANNEL_ID)
        .setContentTitle("Downloading $name")
        .setContentText("$percent% · ${mb(done)} of ${mb(total)}")
        .setSmallIcon(android.R.drawable.stat_sys_download)
        .setProgress(100, percent, false)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(open)
        .addAction(
          android.R.drawable.ic_menu_close_clear_cancel,
          "Cancel",
          WorkManager.getInstance(applicationContext).createCancelPendingIntent(id),
        )
        .build()
    val info =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        ForegroundInfo(NOTIFICATION_ID, notification)
      }
    setForegroundAsync(info)
  }

  private fun mb(bytes: Long): String = "%.0f MB".format(bytes / (1024.0 * 1024.0))

  companion object {
    const val KEY_SPEC = "spec"
    const val KEY_DONE = "done"
    const val KEY_TOTAL = "total"
    const val KEY_ERROR = "error"
    /** Shared by every pack download: only one runs at a time (unique work). */
    private const val NOTIFICATION_ID = 4711
    private const val CHANNEL_ID = "atlas-packs"
    private const val BUFFER_BYTES = 64 * 1024
    private const val CONNECT_TIMEOUT_MS = 20_000
    private const val READ_TIMEOUT_MS = 60_000
    private const val REPORT_INTERVAL_MS = 500L
    private const val MAX_ATTEMPTS = 8
    private const val HTTP_PARTIAL = 206
  }
}
