{
  "targets": [
    {
      "target_name": "mac_temp_native",
      "sources": [
        "lib/src/addon.c",
        "lib/src/temps.c"
      ],
      "cflags": ["-std=c11", "-Wall", "-Wextra", "-Wno-unused-parameter"],
      "xcode_settings": {
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "OTHER_CFLAGS": ["-std=c11"]
      },
      "libraries": [
        "-framework CoreFoundation",
        "-framework IOKit",
        "-ldl"
      ]
    }
  ]
}
