"""List DXGI adapter indices used by ONNX Runtime's DirectML provider."""
import ctypes as c
from ctypes import wintypes as w
import json
import uuid


class Guid(c.Structure):
    _fields_ = [("data", c.c_ubyte * 16)]


class Luid(c.Structure):
    _fields_ = [("low", w.DWORD), ("high", w.LONG)]


class Description(c.Structure):
    _fields_ = [("name", w.WCHAR * 128), ("vendor", w.UINT), ("device", w.UINT),
                ("subsystem", w.UINT), ("revision", w.UINT), ("video_memory", c.c_size_t),
                ("system_memory", c.c_size_t), ("shared_memory", c.c_size_t),
                ("luid", Luid), ("flags", w.UINT)]


def method(pointer, slot, result, *arguments):
    table = c.cast(pointer, c.POINTER(c.POINTER(c.c_void_p))).contents
    return c.WINFUNCTYPE(result, c.c_void_p, *arguments)(table[slot])


def adapters():
    identifier = Guid((c.c_ubyte * 16).from_buffer_copy(uuid.UUID("770aae78-f26f-4dba-a829-253c83d1b387").bytes_le))
    factory = c.c_void_p()
    create = c.WinDLL("dxgi").CreateDXGIFactory1
    create.argtypes = [c.POINTER(Guid), c.POINTER(c.c_void_p)]
    create.restype = w.LONG
    if create(c.byref(identifier), c.byref(factory)) < 0:
        raise RuntimeError("Cannot enumerate DirectML adapters")
    result = []
    try:
        index = 0
        while True:
            adapter = c.c_void_p()
            status = method(factory, 12, w.LONG, w.UINT, c.POINTER(c.c_void_p))(factory, index, c.byref(adapter))
            if status == -2005270526:  # DXGI_ERROR_NOT_FOUND
                break
            if status < 0:
                raise RuntimeError(f"DXGI enumeration failed: {status}")
            try:
                description = Description()
                status = method(adapter, 10, w.LONG, c.POINTER(Description))(adapter, c.byref(description))
                if status < 0:
                    raise RuntimeError("Cannot read DirectML adapter description")
                result.append({"index":index, "name":description.name, "vendor_id":description.vendor,
                               "dedicated_video_bytes":description.video_memory, "software":bool(description.flags & 2)})
            finally:
                method(adapter, 2, w.ULONG)(adapter)
            index += 1
    finally:
        method(factory, 2, w.ULONG)(factory)
    return result


if __name__ == "__main__":
    print(json.dumps(adapters(), indent=2))
