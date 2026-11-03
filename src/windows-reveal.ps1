$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class DshImageRevealNative{
[DllImport("shell32.dll",CharSet=CharSet.Unicode)]
static extern int SHParseDisplayName(string name,IntPtr bind,out IntPtr pidl,uint attrs,out uint readAttributes);
[DllImport("shell32.dll")] static extern IntPtr ILFindLastID(IntPtr pidl);
[DllImport("shell32.dll")] static extern int SHOpenFolderAndSelectItems(IntPtr folder,uint count,IntPtr children,uint flags);
[DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window,int command);
[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,IntPtr processId);
[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
[DllImport("user32.dll")] static extern bool AttachThreadInput(uint first,uint second,bool attach);
[StructLayout(LayoutKind.Sequential)] struct Rect{public int Left,Top,Right,Bottom;}
[StructLayout(LayoutKind.Sequential)] struct MonitorInfo{public uint Size;public Rect Monitor,Work;public uint Flags;}
[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr window,uint flags);
[DllImport("user32.dll",CharSet=CharSet.Auto)] static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window,out Rect rectangle);
[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
static bool OnScreen(IntPtr window){
IntPtr monitor=MonitorFromWindow(window,0);
if(monitor==IntPtr.Zero)return false;
MonitorInfo info=new MonitorInfo();info.Size=(uint)Marshal.SizeOf(typeof(MonitorInfo));
Rect bounds;
if(!GetMonitorInfo(monitor,ref info)||!GetWindowRect(window,out bounds))return false;
int width=Math.Min(bounds.Right,info.Work.Right)- Math.Max(bounds.Left,info.Work.Left);
int height=Math.Min(bounds.Bottom,info.Work.Bottom)- Math.Max(bounds.Top,info.Work.Top);
return width>=32&&height>=32;
}
static void MoveIfOffScreen(IntPtr window){
if(IsIconic(window)||MonitorFromWindow(window,0)!=IntPtr.Zero)return;
IntPtr monitor=MonitorFromWindow(GetForegroundWindow(),2);
MonitorInfo info=new MonitorInfo();info.Size=(uint)Marshal.SizeOf(typeof(MonitorInfo));
Rect bounds;
if(monitor==IntPtr.Zero||!GetMonitorInfo(monitor,ref info)||!GetWindowRect(window,out bounds))return;
int x=info.Work.Left+Math.Max(0,(info.Work.Right - info.Work.Left -(bounds.Right - bounds.Left))/ 2);
int y=info.Work.Top+Math.Max(0,(info.Work.Bottom - info.Work.Top -(bounds.Bottom - bounds.Top))/ 2);
SetWindowPos(window,IntPtr.Zero,x,y,0,0,0x0015);
}
public static IntPtr RootWindow(IntPtr window){
if(window==IntPtr.Zero||!IsWindow(window))return IntPtr.Zero;
IntPtr root=GetAncestor(window,2);
return root==IntPtr.Zero ? window : root;
}
public static bool VisibleReady(IntPtr window){
return window!=IntPtr.Zero&&IsWindow(window)&&IsWindowVisible(window)&&!IsIconic(window)&&OnScreen(window);
}
public static bool IsForeground(IntPtr window){
IntPtr root=RootWindow(window);
return root!=IntPtr.Zero&&RootWindow(GetForegroundWindow())==root;
}
public static void RestoreAndActivate(IntPtr window){
window=RootWindow(window);
if(window==IntPtr.Zero||(VisibleReady(window)&&IsForeground(window)))return;
if(IsIconic(window))ShowWindowAsync(window,9);
else if(!IsWindowVisible(window))ShowWindowAsync(window,5);
for(int i=0;i<8&&(IsIconic(window)||!IsWindowVisible(window));i++)System.Threading.Thread.Sleep(30);
MoveIfOffScreen(window);
if(IsForeground(window))return;
uint current=GetCurrentThreadId(),foreground=GetWindowThreadProcessId(GetForegroundWindow(),IntPtr.Zero),target=GetWindowThreadProcessId(window,IntPtr.Zero);
bool attachedForeground=false,attachedTarget=false;
try{
if(foreground!=0&&foreground!=current)attachedForeground=AttachThreadInput(current,foreground,true);
if(target!=0&&target!=current&&target!=foreground)attachedTarget=AttachThreadInput(current,target,true);
SetForegroundWindow(window);
}finally{
if(attachedTarget)AttachThreadInput(current,target,false);
if(attachedForeground)AttachThreadInput(current,foreground,false);
}
}
static bool LocalAbsolute(string value){
if(String.IsNullOrWhiteSpace(value)||value.Length<3||!Char.IsLetter(value[0])||value[1]!=':'||(value[2]!='\\'&&value[2]!='/'))return false;
for(int i=0;i<value.Length;i++)if(Char.IsControl(value[i])||value[i]=='"'||(i!=1&&value[i]==':'))return false;
return true;
}
public static void OpenDirectoryFallback(string dir){
string root=Environment.GetEnvironmentVariable("SystemRoot");
if(String.IsNullOrWhiteSpace(root))root=Environment.GetEnvironmentVariable("WINDIR");
if(String.IsNullOrWhiteSpace(root))root="C:/Windows";
if(!LocalAbsolute(root)||!LocalAbsolute(dir))throw new InvalidOperationException("Invalid path");
ProcessStartInfo start=new ProcessStartInfo();
start.FileName=Path.Combine(Path.GetFullPath(root),"explorer.exe");
start.Arguments="\""+Path.GetFullPath(dir)+"\"";
start.UseShellExecute=false;
start.WorkingDirectory=Path.GetFullPath(root);
using(Process process=Process.Start(start)){}
}
public static void Show(string file){
IntPtr folder=IntPtr.Zero,item=IntPtr.Zero,array=IntPtr.Zero;
uint attrs;
try{
Marshal.ThrowExceptionForHR(SHParseDisplayName(Path.GetDirectoryName(file),IntPtr.Zero,out folder,0,out attrs));
Marshal.ThrowExceptionForHR(SHParseDisplayName(file,IntPtr.Zero,out item,0,out attrs));
array=Marshal.AllocHGlobal(IntPtr.Size);
Marshal.WriteIntPtr(array,ILFindLastID(item));
Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(folder,1,array,0));
}finally{
if(array!=IntPtr.Zero)Marshal.FreeHGlobal(array);
if(item!=IntPtr.Zero)Marshal.FreeCoTaskMem(item);
if(folder!=IntPtr.Zero)Marshal.FreeCoTaskMem(folder);
}
}
}
'@
function Drop-Com($Value){
if($null -ne $Value -and [Runtime.InteropServices.Marshal]::IsComObject($Value)){
try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($Value)} catch {}
}
}
function Drop-Entry($Entry){
if($null -ne $Entry){ foreach ($name in 'Self','Folder','Document','Window'){ Drop-Com $Entry.$name}}
}
function Local([string]$Value){
return [IO.Path]::GetFullPath($Value).TrimEnd([char[]]@('\', '/'))
}
function Is-Selected($Document, [string]$Target){
$sel=$null;$item=$null
try {
$sel=$Document.SelectedItems()
if($sel.Count -ne 1){return $false}
$item=$sel.Item(0)
return [StringComparer]::OrdinalIgnoreCase.Equals((Local ([string]$item.Path)), $Target)
} catch {return $false}
finally { Drop-Com $item; Drop-Com $sel}
}
function Find-Entry($Shell, [string]$Dir, [IntPtr]$Chosen, $W){
$windows=$null;$best=$null
try {
$windows=$Shell.Windows()
for ($index=0;$index -lt $windows.Count;$index++){
if($W.ElapsedMilliseconds -ge 6500){ break}
$window=$null;$document=$null;$folder=$null;$self=$null;$keep=$false
try {
$window=$windows.Item($index)
if(-not [StringComparer]::OrdinalIgnoreCase.Equals([IO.Path]::GetFileName([string]$window.FullName), 'explorer.exe')){ continue}
$document=$window.Document;$folder=$document.Folder;$self=$folder.Self
if(-not [StringComparer]::OrdinalIgnoreCase.Equals((Local ([string]$self.Path)), $Dir)){ continue}
$handle=[DshImageRevealNative]::RootWindow([IntPtr]([long]$window.HWND))
if($handle -eq [IntPtr]::Zero -or ($Chosen -ne [IntPtr]::Zero -and $handle -ne $Chosen)){ continue}
$entry=[pscustomobject]@{ Window=$window; Document=$document; Folder=$folder; Self=$self; Handle=$handle}
if($Chosen -ne [IntPtr]::Zero -or [DshImageRevealNative]::IsForeground($handle)){
Drop-Entry $best;$best=$null;$keep=$true; return $entry
}
if($null -eq $best){ $best=$entry;$keep=$true}
} catch {} finally {
if(-not $keep){ Drop-Com $self; Drop-Com $folder; Drop-Com $document; Drop-Com $window}
}
}
} finally { Drop-Com $windows}
return $best
}
function Select-Once($Entry, [string]$Target, [ref]$Attempted){
$item=$null
try {
if(Is-Selected $Entry.Document $Target){return}
$item=$Entry.Folder.ParseName([IO.Path]::GetFileName($Target))
if($null -eq $item -or -not [StringComparer]::OrdinalIgnoreCase.Equals((Local ([string]$item.Path)), $Target)){return}
$Attempted.Value=$true
[void]$Entry.Document.SelectItem($item, 13)
} finally { Drop-Com $item}
}
function Invoke-Transaction($Shell, [string]$File, $W){
$target=Local $File
$dir=Local ([IO.Path]::GetDirectoryName($File))
$chosen=[IntPtr]::Zero;$seen=$false;$opened=$false;$didFallback=$false
$didSelect=$false;$didActivate=$false;$settle=0L;$verifyAt=0L;$openAt=0L;$stable=-1L
while ($W.ElapsedMilliseconds -lt 6500){
$entry=$null
try {
$entry=Find-Entry $Shell $dir $chosen $W
if($null -ne $entry){
$chosen=$entry.Handle;$seen=$true
$sel=Is-Selected $entry.Document $target
$vis=[bool]$entry.Window.Visible -and [DshImageRevealNative]::VisibleReady($chosen)
$fg=[DshImageRevealNative]::IsForeground($chosen)
if($sel -and $vis -and $fg){
if(-not ($opened -or $didSelect -or $didActivate)){return 0}
if($stable -lt 0){ $stable=$W.ElapsedMilliseconds}
if($W.ElapsedMilliseconds -ge $verifyAt -and $W.ElapsedMilliseconds -ge $settle -and $W.ElapsedMilliseconds - $stable -ge 200){return 0}
} else {
$stable=-1L
if(-not $sel -and -not $didSelect -and -not $didActivate -and $W.ElapsedMilliseconds -ge $settle){
Select-Once $entry $target ([ref]$didSelect)
if($didSelect){ $settle=$W.ElapsedMilliseconds + 250}
}
if($sel -and -not $didActivate -and $W.ElapsedMilliseconds -ge $settle -and $W.ElapsedMilliseconds -lt 6000){
$didActivate=$true
[DshImageRevealNative]::RestoreAndActivate($chosen)
$verifyAt=$W.ElapsedMilliseconds + 300
}
if($sel -and $vis -and $didActivate -and $W.ElapsedMilliseconds -ge $verifyAt){return 10}
}
} else {
$stable=-1L
if(-not $seen -and -not $opened){
$opened=$true;$openAt=$W.ElapsedMilliseconds
try { [DshImageRevealNative]::Show($File)} catch {}
$settle=$W.ElapsedMilliseconds + 650
}
}
if(-not $seen -and $opened -and -not $didFallback -and $W.ElapsedMilliseconds - $openAt -ge 2500){
$didFallback=$true
try { [DshImageRevealNative]::OpenDirectoryFallback([IO.Path]::GetDirectoryName($File))} catch {}
$settle=$W.ElapsedMilliseconds + 650
}
} catch {} finally { Drop-Entry $entry}
Start-Sleep -Milliseconds 100
}
return 1
}
$exitCode=1;$shell=$null
try {
$file=[Environment]::GetEnvironmentVariable('DSH_GPT_IMAGES_REVEAL_PATH')
if([string]::IsNullOrWhiteSpace($file) -or $file -notmatch '^[A-Za-z]:[\\/]' -or $file -match '[\x00-\x1f\x7f"]' -or $file.Substring(2).Contains(':')){ throw 'Invalid path'}
$file=[IO.Path]::GetFullPath($file)
if(-not [IO.File]::Exists($file)){ throw 'Missing image'}
$watch=[Diagnostics.Stopwatch]::StartNew()
$shell=New-Object -ComObject Shell.Application
$exitCode=Invoke-Transaction $shell $file $watch
} catch {} finally { Drop-Com $shell}
exit $exitCode
