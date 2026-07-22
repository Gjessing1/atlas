// JNI bridge from ValhallaModule.kt to the embedded Valhalla routing core.
// One actor (engine) at a time, matching one open region pack; a mutex guards
// it because expo's async queue gives no ordering promise between open/route/
// close. Errors surface as java.lang.RuntimeException → rejected JS promises.
#include <jni.h>

#include <memory>
#include <mutex>
#include <sstream>
#include <string>

#include <boost/property_tree/json_parser.hpp>
#include <boost/property_tree/ptree.hpp>
#include <valhalla/tyr/actor.h>

namespace {

std::mutex g_mutex;
std::unique_ptr<valhalla::tyr::actor_t> g_actor;

void throw_runtime(JNIEnv* env, const char* what) {
  jclass cls = env->FindClass("java/lang/RuntimeException");
  if (cls != nullptr) {
    env->ThrowNew(cls, what);
  }
}

std::string to_string(JNIEnv* env, jstring s) {
  const char* chars = env->GetStringUTFChars(s, nullptr);
  std::string out(chars == nullptr ? "" : chars);
  if (chars != nullptr) {
    env->ReleaseStringUTFChars(s, chars);
  }
  return out;
}

}  // namespace

extern "C" JNIEXPORT void JNICALL Java_io_gjessing_atlas_valhalla_ValhallaModule_nativeOpen(
    JNIEnv* env,
    jobject /*this*/,
    jstring config_json) {
  try {
    std::istringstream stream(to_string(env, config_json));
    boost::property_tree::ptree config;
    boost::property_tree::read_json(stream, config);
    std::lock_guard<std::mutex> lock(g_mutex);
    // auto_cleanup releases per-request scratch memory after every action —
    // slightly slower, much friendlier to a phone's memory budget.
    g_actor = std::make_unique<valhalla::tyr::actor_t>(config, /*auto_cleanup=*/true);
  } catch (const std::exception& e) {
    throw_runtime(env, e.what());
  }
}

extern "C" JNIEXPORT jstring JNICALL Java_io_gjessing_atlas_valhalla_ValhallaModule_nativeRoute(
    JNIEnv* env,
    jobject /*this*/,
    jstring request_json) {
  try {
    const std::string request = to_string(env, request_json);
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_actor) {
      throw_runtime(env, "valhalla engine is not open");
      return nullptr;
    }
    const std::string response = g_actor->route(request);
    return env->NewStringUTF(response.c_str());
  } catch (const std::exception& e) {
    throw_runtime(env, e.what());
    return nullptr;
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_io_gjessing_atlas_valhalla_ValhallaModule_nativeTraceAttributes(
    JNIEnv* env,
    jobject /*this*/,
    jstring request_json) {
  try {
    const std::string request = to_string(env, request_json);
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_actor) {
      throw_runtime(env, "valhalla engine is not open");
      return nullptr;
    }
    const std::string response = g_actor->trace_attributes(request);
    return env->NewStringUTF(response.c_str());
  } catch (const std::exception& e) {
    throw_runtime(env, e.what());
    return nullptr;
  }
}

extern "C" JNIEXPORT void JNICALL Java_io_gjessing_atlas_valhalla_ValhallaModule_nativeClose(
    JNIEnv* env,
    jobject /*this*/) {
  std::lock_guard<std::mutex> lock(g_mutex);
  g_actor.reset();
}
