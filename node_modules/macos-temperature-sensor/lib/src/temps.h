#pragma once
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
  char name[128];   // service "Product" string
  double temp_c;    // Celsius
} mt_sensor_t;

typedef struct {
  double p_core_avg_c;
  double e_core_avg_c;
  size_t sensor_count;
  mt_sensor_t* sensors;
} mt_snapshot_t;

int mt_read_snapshot(mt_snapshot_t* out);

void mt_free_snapshot(mt_snapshot_t* s);

#ifdef __cplusplus
}
#endif
