#include <node_api.h>
#include <sys/prctl.h>

/* Loaded in the supervisor itself, before it reads secrets or listens. An exec wrapper's
 * PR_SET_DUMPABLE would be reset by execve; changing the running Node process is required. */
NAPI_MODULE_INIT() {
  if (prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L) != 0 || prctl(PR_GET_DUMPABLE, 0L, 0L, 0L, 0L) != 0) {
    napi_throw_error(env, NULL, "Cannot protect the runtime supervisor from same-uid process access");
    return NULL;
  }
  return exports;
}
