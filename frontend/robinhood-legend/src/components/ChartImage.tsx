export function ChartImage({ src = '/chart-fixtures/composite-01.png', rect }: { src?: string; rect?: { width: number; height: number } }) {
  return <img src={src} alt="" style={{position:'absolute',inset:0,width:'100%',height:'100%',objectFit:'fill',display:'block',pointerEvents:'none',zIndex:0}} />;
}
