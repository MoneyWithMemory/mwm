import { useEffect, useEffectEvent, useRef, useState } from 'react'

interface DetectedCode {
  rawValue: string
}
interface Detector {
  detect(source: HTMLVideoElement): Promise<DetectedCode[]>
}
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => Detector
  }
}

interface QrScannerProps {
  onDetected: (value: string) => void
  onFailed: (message: string) => void
}

const SCAN_INTERVAL_MS = 250

/** Rear camera preview that reports the first QR code it reads. Stops the camera on unmount. */
export function QrScanner({ onDetected, onFailed }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [ready, setReady] = useState(false)
  const detected = useEffectEvent(onDetected)
  const failed = useEffectEvent(onFailed)

  useEffect(() => {
    let stream: MediaStream | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let cancelled = false

    async function start() {
      try {
        const Detector = window.BarcodeDetector
        if (!Detector) throw new Error('unsupported')
        const detector = new Detector({ formats: ['qr_code'] })
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
        const video = videoRef.current
        if (cancelled || !video) return
        video.srcObject = stream
        await video.play()
        setReady(true)
        let busy = false
        timer = setInterval(async () => {
          if (busy) return
          busy = true
          try {
            const [code] = await detector.detect(video)
            if (code?.rawValue) detected(code.rawValue)
          } catch {
            // A frame that cannot be read is not an error: try the next one.
          } finally {
            busy = false
          }
        }, SCAN_INTERVAL_MS)
      } catch (err) {
        const denied = err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')
        failed(denied ? 'Camera access was denied. Paste the code instead.' : "Couldn't start the camera. Paste the code instead.")
      }
    }
    void start()

    return () => {
      cancelled = true
      clearInterval(timer)
      stream?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded-card bg-surface-muted">
      <video ref={videoRef} className="size-full object-cover" playsInline muted aria-label="Camera preview" />
      {!ready && <span className="absolute inset-0 flex items-center justify-center text-sm text-hint">Starting camera…</span>}
      <span className="pointer-events-none absolute inset-8 rounded-card border-2 border-accent/70" aria-hidden="true" />
    </div>
  )
}
