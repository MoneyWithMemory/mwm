/** True where the browser can decode QR codes from the camera (Chrome and Android; not Safari). */
export function canScanQr(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia)
}

