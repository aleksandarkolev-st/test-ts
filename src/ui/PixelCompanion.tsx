import { useEffect, useState } from 'react';
import { PixelCanvas } from './vendor/PixelCanvas';
import Ripple from './vendor/Ripple';

const colors = ['#a7dfc2', '#e8edf1', '#203a2d'];
export default function PixelCompanion({ size = 'small' }: { size?: 'small' | 'large' }) {
  const [hovered, setHovered] = useState(false);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [motion, setMotion] = useState(false);
  useEffect(() => {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotion(!preference.matches);
    update(); preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  return <div className={`pixel-companion ${size}`} aria-hidden="true"
    onPointerEnter={event => { const rect = event.currentTarget.getBoundingClientRect(); setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top }); setHovered(true); }}
    onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); setPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top }); }}
    onPointerLeave={() => { setHovered(false); setPointer(null); }}>
    {hovered && motion && <PixelCanvas className="companion-pixels" gap={8} colors={colors} speed={0.12} noFocus pointer={pointer} />}
    <Ripple style={{ width: '100%', height: '100%' }} amplitude={0.25} shine={0.18} dispersion={0} refraction={0} interval={0} trigger={motion ? 'click' : 'none'}>
      <img src="/art/copilot-pixel.png" alt="" draggable={false} width={size === 'large' ? 164 : 88} height={size === 'large' ? 164 : 88} />
    </Ripple>
  </div>;
}
