import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/**
 * 共有リンクの QR コード。
 *
 * 部活や店頭では「リンクを送る」より「その場で読み取ってもらう」ほうが早い。
 * 画像にせず SVG で描くので、拡大しても粗くならず印刷にも耐える。
 */
export default function QrCode({ value, size = 176 }: { value: string; size?: number }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()

    const modules = qr.getModuleCount()
    let d = ''
    for (let row = 0; row < modules; row++) {
      for (let col = 0; col < modules; col++) {
        if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`
      }
    }
    return { count: modules, path: d }
  }, [value])

  // 白フチ（クワイエットゾーン）が無いと読み取れない機種があるので 2 モジュールぶん足す
  const margin = 2
  const box = count + margin * 2

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      role="img"
      aria-label="共有リンクの QR コード"
      className="rounded-lg bg-white"
      shapeRendering="crispEdges"
    >
      <rect width={box} height={box} fill="#ffffff" />
      <g transform={`translate(${margin} ${margin})`}>
        <path d={path} fill="#0f172a" />
      </g>
    </svg>
  )
}
