#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#include "temps.h"

static napi_value make_error(napi_env env, const char* msg) {
  napi_value err, str;
  napi_create_string_utf8(env, msg, NAPI_AUTO_LENGTH, &str);
  napi_create_error(env, NULL, str, &err);
  return err;
}

static napi_value js_snapshot(napi_env env, napi_callback_info info) {
  (void)info;

  mt_snapshot_t s;
  int rc = mt_read_snapshot(&s);
  if (rc != 0) {
    napi_throw(env, make_error(env, "Failed to read temperature snapshot (IOHID)."));
    return NULL;
  }

  napi_value obj;
  napi_create_object(env, &obj);

  napi_value pAvg, eAvg;
  napi_create_double(env, s.p_core_avg_c, &pAvg);
  napi_create_double(env, s.e_core_avg_c, &eAvg);
  napi_set_named_property(env, obj, "pCoreAvgC", pAvg);
  napi_set_named_property(env, obj, "eCoreAvgC", eAvg);

  napi_value arr;
  napi_create_array_with_length(env, (size_t)s.sensor_count, &arr);

  for (size_t i = 0; i < s.sensor_count; i++) {
    napi_value item, name, temp;
    napi_create_object(env, &item);
    napi_create_string_utf8(env, s.sensors[i].name, NAPI_AUTO_LENGTH, &name);
    napi_create_double(env, s.sensors[i].temp_c, &temp);
    napi_set_named_property(env, item, "name", name);
    napi_set_named_property(env, item, "tempC", temp);
    napi_set_element(env, arr, (uint32_t)i, item);
  }

  napi_set_named_property(env, obj, "sensors", arr);

  mt_free_snapshot(&s);
  return obj;
}

static napi_value js_listSensors(napi_env env, napi_callback_info info) {
  (void)info;

  mt_snapshot_t s;
  int rc = mt_read_snapshot(&s);
  if (rc != 0) {
    napi_throw(env, make_error(env, "Failed to list sensors (IOHID)."));
    return NULL;
  }

  napi_value arr;
  napi_create_array_with_length(env, (size_t)s.sensor_count, &arr);

  for (size_t i = 0; i < s.sensor_count; i++) {
    napi_value item, name, temp;
    napi_create_object(env, &item);
    napi_create_string_utf8(env, s.sensors[i].name, NAPI_AUTO_LENGTH, &name);
    napi_create_double(env, s.sensors[i].temp_c, &temp);
    napi_set_named_property(env, item, "name", name);
    napi_set_named_property(env, item, "tempC", temp);
    napi_set_element(env, arr, (uint32_t)i, item);
  }

  mt_free_snapshot(&s);
  return arr;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn1, fn2;
  napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, js_snapshot, NULL, &fn1);
  napi_create_function(env, "listSensors", NAPI_AUTO_LENGTH, js_listSensors, NULL, &fn2);

  napi_set_named_property(env, exports, "snapshot", fn1);
  napi_set_named_property(env, exports, "listSensors", fn2);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
