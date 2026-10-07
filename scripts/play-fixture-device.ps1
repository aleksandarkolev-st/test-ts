param([string]$InputPath, [string]$OutputName, [switch]$ListOutputs)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class FixtureWaveOut {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct Caps { public ushort Manufacturer, Product; public uint Version; [MarshalAs(UnmanagedType.ByValTStr,SizeConst=32)] public string Name; public uint Formats; public ushort Channels, Reserved; public uint Support; }
    [StructLayout(LayoutKind.Sequential, Pack=2)]
    struct Format { public ushort Tag, Channels; public uint Rate, BytesPerSecond; public ushort Align, Bits, Extra; }
    [StructLayout(LayoutKind.Sequential)]
    struct Header { public IntPtr Data; public uint Length, Recorded; public UIntPtr User; public uint Flags, Loops; public IntPtr Next; public UIntPtr Reserved; }
    [DllImport("winmm.dll")] static extern uint waveOutGetNumDevs();
    [DllImport("winmm.dll",CharSet=CharSet.Unicode)] static extern uint waveOutGetDevCapsW(UIntPtr id,out Caps caps,uint size);
    [DllImport("winmm.dll")] static extern uint waveOutOpen(out IntPtr handle,uint id,ref Format format,UIntPtr callback,UIntPtr instance,uint flags);
    [DllImport("winmm.dll")] static extern uint waveOutPrepareHeader(IntPtr handle,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveOutWrite(IntPtr handle,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveOutUnprepareHeader(IntPtr handle,IntPtr header,uint size);
    [DllImport("winmm.dll")] static extern uint waveOutReset(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint waveOutClose(IntPtr handle);
    static void Check(uint code) { if(code!=0) throw new InvalidOperationException("Fixture waveOut error: "+code); }
    public static string[] Outputs() {
        var names=new List<string>();
        for(uint i=0;i<waveOutGetNumDevs();i++) { Caps caps; Check(waveOutGetDevCapsW(new UIntPtr(i),out caps,(uint)Marshal.SizeOf(typeof(Caps)))); names.Add(caps.Name); }
        return names.ToArray();
    }
    public static void Play(string path,string name) {
        var names=Outputs(); int selected=-1;
        for(int i=0;i<names.Length;i++) {
            if(names[i].IndexOf(name,StringComparison.OrdinalIgnoreCase)>=0 || name.StartsWith(names[i],StringComparison.OrdinalIgnoreCase)) {
                if(selected>=0) throw new InvalidOperationException("Fixture output name is ambiguous"); selected=i;
            }
        }
        if(selected<0) throw new InvalidOperationException("Requested fixture output is unavailable: "+name);
        byte[] bytes=File.ReadAllBytes(path);
        if(bytes.Length<44 || bytes.Length>10*1024*1024 || Encoding.ASCII.GetString(bytes,0,4)!="RIFF" || Encoding.ASCII.GetString(bytes,8,4)!="WAVE") throw new InvalidDataException("Invalid fixture WAV");
        Format format=new Format(); int dataOffset=0,dataLength=0;
        for(int offset=12;offset+8<=bytes.Length;) {
            string chunk=Encoding.ASCII.GetString(bytes,offset,4); uint length=BitConverter.ToUInt32(bytes,offset+4);
            if((long)offset+8+length>bytes.Length) throw new InvalidDataException("Invalid WAV chunk length");
            int start=offset+8;
            if(chunk=="fmt " && length>=16) {
                format.Tag=BitConverter.ToUInt16(bytes,start); format.Channels=BitConverter.ToUInt16(bytes,start+2); format.Rate=BitConverter.ToUInt32(bytes,start+4);
                format.BytesPerSecond=BitConverter.ToUInt32(bytes,start+8); format.Align=BitConverter.ToUInt16(bytes,start+12); format.Bits=BitConverter.ToUInt16(bytes,start+14);
            }
            if(chunk=="data" && dataOffset==0) { dataOffset=start; dataLength=(int)length; }
            offset=checked(start+(int)length+((int)length&1));
        }
        if(format.Tag!=1 || format.Channels<1 || format.Channels>2 || format.Rate<8000 || format.Rate>192000 || (format.Bits!=16 && format.Bits!=24 && format.Bits!=32) || format.Align!=format.Channels*(format.Bits/8) || format.BytesPerSecond!=format.Rate*format.Align || dataLength<=0 || dataLength%format.Align!=0) throw new InvalidDataException("Expected a mono/stereo PCM fixture WAV");
        IntPtr handle=IntPtr.Zero,data=IntPtr.Zero,header=IntPtr.Zero; bool prepared=false;
        uint headerSize=(uint)Marshal.SizeOf(typeof(Header));
        try {
            Check(waveOutOpen(out handle,(uint)selected,ref format,UIntPtr.Zero,UIntPtr.Zero,0));
            data=Marshal.AllocHGlobal(dataLength); Marshal.Copy(bytes,dataOffset,data,dataLength);
            header=Marshal.AllocHGlobal((int)headerSize); Marshal.StructureToPtr(new Header{Data=data,Length=(uint)dataLength},header,false);
            Check(waveOutPrepareHeader(handle,header,headerSize)); prepared=true;
            Check(waveOutWrite(handle,header,headerSize)); var timer=Stopwatch.StartNew();
            double deadline=10000+1000.0*dataLength/format.BytesPerSecond;
            while((((Header)Marshal.PtrToStructure(header,typeof(Header))).Flags&1)==0) {
                if(timer.ElapsedMilliseconds>deadline) throw new TimeoutException("Fixture playback stalled"); Thread.Sleep(5);
            }
            Check(waveOutUnprepareHeader(handle,header,headerSize)); prepared=false;
        } finally {
            if(handle!=IntPtr.Zero) { if(prepared) { waveOutReset(handle); waveOutUnprepareHeader(handle,header,headerSize); } waveOutClose(handle); }
            if(header!=IntPtr.Zero) Marshal.FreeHGlobal(header); if(data!=IntPtr.Zero) Marshal.FreeHGlobal(data);
        }
    }
}
'@
if ($ListOutputs) { [FixtureWaveOut]::Outputs(); return }
if (!$InputPath -or !$OutputName) { throw 'InputPath and OutputName are required' }
[FixtureWaveOut]::Play((Resolve-Path -LiteralPath $InputPath).Path,$OutputName)
