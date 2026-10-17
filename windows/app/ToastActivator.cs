using System.Runtime.InteropServices;

namespace Mystical;

/// How a tap on a toast reaches an unpackaged app. A banner on screen fires the
/// toast object's own Activated event in-process, but a toast that went to the
/// notification center (Focus Assist, a timed-out banner, a tap minutes later)
/// is activated by Windows through COM: it looks up the app id's
/// `CustomActivator` CLSID, connects to the running instance's class object
/// (or launches `LocalServer32` — this exe with -ToastActivated — when none
/// runs) and calls INotificationActivationCallback.Activate with the toast's
/// `launch` or the button's `arguments`. Notifier registers the class object
/// at every start and the registry keys with it; both paths land in
/// Notifier's one activation handler.
[ComImport, Guid("53E31837-6600-4A81-9395-75CFFE746F94"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface INotificationActivationCallback
{
    void Activate([MarshalAs(UnmanagedType.LPWStr)] string appUserModelId,
                  [MarshalAs(UnmanagedType.LPWStr)] string invokedArgs,
                  [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 3)] NotificationUserInputData[] data,
                  uint count);
}

[StructLayout(LayoutKind.Sequential)]
public struct NotificationUserInputData
{
    [MarshalAs(UnmanagedType.LPWStr)] public string Key;
    [MarshalAs(UnmanagedType.LPWStr)] public string Value;
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None), Guid(ToastActivator.Clsid)]
public sealed class ToastActivator : INotificationActivationCallback
{
    /// This app's activator class, named in the registry beside the app id.
    public const string Clsid = "6f1e1b2a-5c3d-4a2e-9b7f-2d9c1a4e8f31";
    /// Set by Notifier: the toast's invokedArgs, delivered on the COM thread.
    public static Action<string>? OnActivate;

    public void Activate(string appUserModelId, string invokedArgs, NotificationUserInputData[] data, uint count) =>
        OnActivate?.Invoke(invokedArgs ?? "");
}

[ComImport, Guid("00000001-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IClassFactory
{
    [PreserveSig] int CreateInstance(IntPtr pUnkOuter, ref Guid riid, out IntPtr ppvObject);
    [PreserveSig] int LockServer(bool fLock);
}

/// The class object COM asks for an activator through.
sealed class ToastActivatorFactory : IClassFactory
{
    const int ClassENoAggregation = unchecked((int)0x80040110);

    public int CreateInstance(IntPtr pUnkOuter, ref Guid riid, out IntPtr ppvObject)
    {
        ppvObject = IntPtr.Zero;
        if (pUnkOuter != IntPtr.Zero) return ClassENoAggregation;
        var unk = Marshal.GetIUnknownForObject(new ToastActivator());
        try
        {
            var iid = riid;
            return Marshal.QueryInterface(unk, in iid, out ppvObject);
        }
        finally
        {
            Marshal.Release(unk);
        }
    }

    public int LockServer(bool fLock) => 0;

    [DllImport("ole32.dll")]
    static extern int CoRegisterClassObject(in Guid rclsid, [MarshalAs(UnmanagedType.IUnknown)] object pUnk,
                                            uint dwClsContext, uint flags, out uint lpdwRegister);

    const uint ClsctxLocalServer = 4;
    const uint RegclsMultipleUse = 1;
    static ToastActivatorFactory? registered;   // held: COM keeps only a weak hold on it

    /// Registers the class object for this process's lifetime. False = COM
    /// refused, and only on-screen banners will reach us.
    public static bool Register()
    {
        try
        {
            registered = new ToastActivatorFactory();
            var clsid = new Guid(ToastActivator.Clsid);
            return CoRegisterClassObject(in clsid, registered, ClsctxLocalServer, RegclsMultipleUse, out _) == 0;
        }
        catch (Exception)
        {
            return false;
        }
    }
}
