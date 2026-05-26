#include "temps.h"

#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <stdlib.h>
#include <string.h>

typedef void* IOHIDEventSystemClientRef;
typedef void* IOHIDServiceClientRef;
typedef void* IOHIDEventRef;

#ifndef kIOHIDEventTypeTemperature
#define kIOHIDEventTypeTemperature 15
#endif

static inline uint32_t IOHIDEventFieldBase_local(uint32_t type) {
  return (type << 16);
}

typedef IOHIDEventSystemClientRef (*pIOHIDEventSystemClientCreate)(CFAllocatorRef allocator);
typedef CFArrayRef (*pIOHIDEventSystemClientCopyServices)(IOHIDEventSystemClientRef client);

typedef CFTypeRef (*pIOHIDServiceClientCopyProperty)(IOHIDServiceClientRef service, CFStringRef key);
typedef IOHIDEventRef (*pIOHIDServiceClientCopyEvent)(IOHIDServiceClientRef service, int32_t type, uint64_t options, uint32_t timeout);

typedef double (*pIOHIDEventGetFloatValue)(IOHIDEventRef event, uint32_t field);

static pIOHIDEventSystemClientCreate      fClientCreate = NULL;
static pIOHIDEventSystemClientCopyServices fCopyServices = NULL;
static pIOHIDServiceClientCopyProperty     fCopyProperty = NULL;
static pIOHIDServiceClientCopyEvent        fCopyEvent = NULL;
static pIOHIDEventGetFloatValue            fGetFloatValue = NULL;

static int resolve_hid_symbols(void) {
  if (fClientCreate) return 1; // already resolved

  void* h = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_LAZY);
  if (!h) return 0;

  fClientCreate  = (pIOHIDEventSystemClientCreate)dlsym(h, "IOHIDEventSystemClientCreate");
  fCopyServices  = (pIOHIDEventSystemClientCopyServices)dlsym(h, "IOHIDEventSystemClientCopyServices");

  fCopyProperty  = (pIOHIDServiceClientCopyProperty)dlsym(h, "IOHIDServiceClientCopyProperty");
  fCopyEvent     = (pIOHIDServiceClientCopyEvent)dlsym(h, "IOHIDServiceClientCopyEvent");

  fGetFloatValue = (pIOHIDEventGetFloatValue)dlsym(h, "IOHIDEventGetFloatValue");

  return (fClientCreate && fCopyServices && fCopyProperty && fCopyEvent && fGetFloatValue) ? 1 : 0;
}

static int cfstring_to_cstr(CFStringRef s, char* out, size_t out_sz) {
  if (!s || !out || out_sz == 0) return 0;
  out[0] = '\0';
  return CFStringGetCString(s, out, (CFIndex)out_sz, kCFStringEncodingUTF8) ? 1 : 0;
}

static int has_prefix(const char* s, const char* prefix) {
  if (!s || !prefix) return 0;
  size_t n = strlen(prefix);
  return strncmp(s, prefix, n) == 0;
}

static double read_temp_from_service(IOHIDServiceClientRef sc) {
  IOHIDEventRef ev = fCopyEvent(sc, kIOHIDEventTypeTemperature, 0, 0);
  if (!ev) return 0.0;

  double v = fGetFloatValue(ev, IOHIDEventFieldBase_local(kIOHIDEventTypeTemperature));

  CFRelease((CFTypeRef)ev);
  return v;
}

int mt_read_snapshot(mt_snapshot_t* out) {
  if (!out) return 1;
  memset(out, 0, sizeof(*out));

  if (!resolve_hid_symbols()) {
    return 100;
  }

  IOHIDEventSystemClientRef client = fClientCreate(kCFAllocatorDefault);
  if (!client) return 2;

  CFArrayRef services = fCopyServices(client);
  if (!services) {
    CFRelease((CFTypeRef)client);
    return 3;
  }

  CFIndex n = CFArrayGetCount(services);
  if (n <= 0) {
    CFRelease(services);
    CFRelease((CFTypeRef)client);
    return 4;
  }

  size_t cap = 0;
  for (CFIndex i = 0; i < n; i++) {
    IOHIDServiceClientRef sc = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
    if (!sc) continue;
    CFTypeRef product = fCopyProperty(sc, CFSTR("Product"));
    if (product) { cap++; CFRelease(product); }
  }

  if (cap == 0) {
    CFRelease(services);
    CFRelease((CFTypeRef)client);
    return 5;
  }

  mt_sensor_t* sensors = (mt_sensor_t*)calloc(cap, sizeof(mt_sensor_t));
  if (!sensors) {
    CFRelease(services);
    CFRelease((CFTypeRef)client);
    return 6;
  }

  size_t used = 0;
  double p_sum = 0.0; size_t p_cnt = 0;
  double e_sum = 0.0; size_t e_cnt = 0;

  for (CFIndex i = 0; i < n; i++) {
    IOHIDServiceClientRef sc = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
    if (!sc) continue;

    CFTypeRef product = fCopyProperty(sc, CFSTR("Product"));
    if (!product) continue;
    if (CFGetTypeID(product) != CFStringGetTypeID()) { CFRelease(product); continue; }

    char name[128];
    if (!cfstring_to_cstr((CFStringRef)product, name, sizeof(name))) {
      CFRelease(product);
      continue;
    }
    CFRelease(product);

    double temp_c = read_temp_from_service(sc);

    // plausibility filter
    if (temp_c < -20.0 || temp_c > 130.0) continue;

    if (used < cap) {
      strncpy(sensors[used].name, name, sizeof(sensors[used].name) - 1);
      sensors[used].name[sizeof(sensors[used].name) - 1] = '\0';
      sensors[used].temp_c = temp_c;
      used++;
    }

    if (has_prefix(name, "pACC MTR Temp Sensor")) { p_sum += temp_c; p_cnt++; }
    else if (has_prefix(name, "eACC MTR Temp Sensor")) { e_sum += temp_c; e_cnt++; }
  }

  if (used == 0) {
    free(sensors);
    CFRelease(services);
    CFRelease((CFTypeRef)client);
    return 7;
  }

  mt_sensor_t* shrunk = (mt_sensor_t*)realloc(sensors, used * sizeof(mt_sensor_t));
  if (shrunk) sensors = shrunk;

  out->sensors = sensors;
  out->sensor_count = used;
  out->p_core_avg_c = (p_cnt > 0) ? (p_sum / (double)p_cnt) : 0.0;
  out->e_core_avg_c = (e_cnt > 0) ? (e_sum / (double)e_cnt) : 0.0;

  CFRelease(services);
  CFRelease((CFTypeRef)client);
  return 0;
}

void mt_free_snapshot(mt_snapshot_t* s) {
  if (!s) return;
  free(s->sensors);
  s->sensors = NULL;
  s->sensor_count = 0;
  s->p_core_avg_c = 0.0;
  s->e_core_avg_c = 0.0;
}
