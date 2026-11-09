/* Stub for @capacitor/core and @capacitor-community/bluetooth-le.
 * The Capacitor BLE client cannot work inside the native library, so these
 * packages are replaced at bundle time to keep the bundle small. */

export const Capacitor = {
  getPlatform: () => "web",
  isNativePlatform: () => false,
};

const unavailable = () => {
  throw new Error("Capacitor BLE is not available in libniimblue");
};

export const BleClient = new Proxy({}, { get: () => unavailable });

export type BleCharacteristic = unknown;
export type BleDevice = unknown;
export type BleService = unknown;
