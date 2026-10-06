# Local Windows runtime dispatch changes

Source: `whisper-rs-sys` 0.14.1, fetched by Cargo, including its packaged whisper.cpp and GGML source. Original crate: https://codeberg.org/tazz4843/whisper-rs . The original license declarations and source licenses are retained.

The upstream build script statically links one CPU backend. A build on an AVX512 machine can therefore require instructions unavailable on another Windows computer. Disabling all optimized instructions made the local speech fixture take approximately 2.5 seconds on the development machine.

Local changes:

1. `build.rs` links Windows import libraries instead of static whisper/GGML libraries and stages runtime DLLs for executables, integration tests, and MSI resources. Legacy CPU feature symbols exposed by whisper-rs resolve through the baseline `ggml-cpu-x64` library.
2. `cmake/portable-cpu.cmake` in the application enables shared libraries, GGML backend loading, and all CPU variants with `GGML_NATIVE=OFF`. Each optimized instruction set stays inside its own backend DLL. The dispatcher scores backends using CPU and OS capability checks before selecting one.
3. Three direct `ggml_backend_cpu_buffer_type()` calls in upstream `whisper.cpp/src/whisper.cpp` use the registered CPU device's generic buffer type API. This lets Whisper use the selected dynamic CPU backend.
4. The application explicitly loads backends from its executable directory before loading the speech model. Upstream logging hooks discard transcript-bearing debug output.
5. The crate publishes its actual CMake runtime directory as Cargo metadata. The application's build script refreshes executable, integration-test and bundle DLLs from that directory, including when the dependency build is cached. It also watches the shared bundle destination, so running debug tests between release builds triggers restoration of the release runtime. This prevents stale staged DLLs from changing speech performance.
6. Windows C and C++ compiler flags explicitly include `/O2`. Custom compiler flags passed through cmake-rs can replace the configuration defaults, so relying only on the `Release` configuration left the production runtime unoptimized.

Verification: local speech fixture transcribed in 414 ms with runtime dispatch; real rendered speech passed WASAPI → VAD → Whisper → question detection → native streamed overlay testing. Baseline compatibility and production bundle checks are tracked in `docs/verification.md`.
