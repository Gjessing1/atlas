package io.gjessing.atlas.packdownload

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkManager
import androidx.work.workDataOf
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/**
 * Queue and observe offline-map pack downloads that keep running when Atlas is
 * not in the foreground.
 *
 * One unique work item per pack, so tapping Download twice cannot start two
 * copies. JS owns everything about a pack except the bytes: it prepares the
 * staging directory, hands over the file list, and once the work reports success
 * it verifies, unpacks and swaps the pack into place.
 */
class PackDownloadModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val work: WorkManager
    get() = WorkManager.getInstance(context)

  override fun definition() = ModuleDefinition {
    Name("PackDownload")

    /**
     * Start (or restart) the download of one pack. `specJson` is
     * `{ name, dir, files: [{ url, path, bytes }] }` — plain JSON so the shape
     * stays owned by the TypeScript side. `wifiOnly` makes the system hold the
     * work until the device is on an unmetered network, which is what the
     * automatic pack refresh uses.
     */
    Function("enqueue") { packId: String, specJson: String, wifiOnly: Boolean ->
      val request =
        OneTimeWorkRequest.Builder(PackDownloadWorker::class.java)
          .setInputData(workDataOf(PackDownloadWorker.KEY_SPEC to specJson))
          .setConstraints(
            Constraints.Builder()
              .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
              .setRequiresStorageNotLow(true)
              .build()
          )
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
          .addTag(TAG)
          .addTag(PACK_TAG + packId)
          .build()
      work.enqueueUniqueWork(uniqueName(packId), ExistingWorkPolicy.REPLACE, request)
    }

    /** Every known pack download as JSON, for the UI and for resume decisions. */
    AsyncFunction("jobs") {
      val array = JSONArray()
      for (info in work.getWorkInfosByTag(TAG).get()) {
        val packId =
          info.tags.firstOrNull { it.startsWith(PACK_TAG) }?.removePrefix(PACK_TAG) ?: continue
        array.put(
          JSONObject()
            .put("packId", packId)
            .put("state", info.state.name.lowercase())
            .put("bytesDone", info.progress.getLong(PackDownloadWorker.KEY_DONE, 0L))
            .put("bytesTotal", info.progress.getLong(PackDownloadWorker.KEY_TOTAL, 0L))
            .put("error", info.outputData.getString(PackDownloadWorker.KEY_ERROR) ?: JSONObject.NULL)
        )
      }
      array.toString()
    }

    /** Stop a download. Partly downloaded files stay on disk and can resume. */
    Function("cancel") { packId: String -> work.cancelUniqueWork(uniqueName(packId)) }

    /** Drop a finished/failed record once JS has dealt with it. */
    Function("forget") { packId: String ->
      work.cancelUniqueWork(uniqueName(packId))
      work.pruneWork()
    }

    /**
     * SHA-256 of a file as lowercase hex. The manifest digest of a pack file is
     * hundreds of megabytes; hashing it in JS means reading it back through
     * base64, which takes minutes on a phone and made a finished background
     * download look stuck.
     */
    AsyncFunction("sha256") { path: String ->
      val digest = MessageDigest.getInstance("SHA-256")
      FileInputStream(File(path)).use { input ->
        val buffer = ByteArray(1 shl 16)
        while (true) {
          val read = input.read(buffer)
          if (read <= 0) break
          digest.update(buffer, 0, read)
        }
      }
      digest.digest().joinToString("") { "%02x".format(it) }
    }
  }

  private fun uniqueName(packId: String) = "$PACK_TAG$packId"

  companion object {
    private const val TAG = "atlas-pack-download"
    private const val PACK_TAG = "atlas-pack:"
    private const val BACKOFF_SECONDS = 15L
  }
}
