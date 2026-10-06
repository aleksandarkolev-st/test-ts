# Build a baseline and optimized CPU backends. GGML checks CPUID and OS
# support before selecting a backend; no build-machine instruction set leaks
# into the installer. Each feature set is confined to its own DLL.
set(GGML_NATIVE OFF CACHE BOOL "Runtime CPU dispatch" FORCE)
set(BUILD_SHARED_LIBS ON CACHE BOOL "Runtime CPU dispatch" FORCE)
set(GGML_BACKEND_DL ON CACHE BOOL "Runtime CPU dispatch" FORCE)
set(GGML_CPU_ALL_VARIANTS ON CACHE BOOL "Runtime CPU dispatch" FORCE)
