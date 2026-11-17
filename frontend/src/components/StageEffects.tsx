import type { CSSProperties } from 'react'
import '../assets/stage-effects.css'

export const effectPresets = [
  {
    id: 'sakura',
    name: '樱花飘落',
    description: '轻柔花瓣随风打转，留一点春日的浪漫。',
    icon: '✿',
  },
  {
    id: 'stars',
    name: '星光闪烁',
    description: '细碎星芒明灭，为陪伴添一点闪亮。',
    icon: '✧',
  },
  {
    id: 'fireflies',
    name: '萤火流光',
    description: '温暖的小小光点，缓慢漂游在你身边。',
    icon: '✺',
  },
  {
    id: 'aura',
    name: '柔和光晕',
    description: '淡紫与蜜桃色的柔光，在舞台边缘轻轻呼吸。',
    icon: '◌',
  },
  {
    id: 'snow',
    name: '轻雪纷飞',
    description: '透亮雪粒悠然落下，像一个安静的冬日。',
    icon: '❄',
  },
] as const

export interface StageEffect {
  id: string
  enabled: boolean
  intensity: number
}

const particleCounts: Record<string, number> = {
  sakura: 20,
  stars: 22,
  fireflies: 18,
  aura: 3,
  snow: 40,
}

// A stable integer hash keeps particles in place across re-renders and changes
// in intensity. No Math.random() runs during rendering.
function sample(seed: number) {
  let value = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b)
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35)
  return ((value ^ (value >>> 16)) >>> 0) / 0x100000000
}

function particleStyle(id: string, index: number): CSSProperties {
  const salt = effectPresets.findIndex((effect) => effect.id === id) * 71 + 1
  const seed = index * 17 + salt
  const x = sample(seed)
  const y = sample(seed + 3)
  const variation = sample(seed + 7)
  const duration =
    id === 'sakura'
      ? 11 + variation * 10
      : id === 'snow'
        ? 9 + variation * 12
        : id === 'fireflies'
          ? 5 + variation * 6
          : 2.4 + variation * 3.5
  const size =
    id === 'sakura'
      ? 6 + variation * 7
      : id === 'snow'
        ? 2 + variation * 4
        : id === 'fireflies'
          ? 3 + variation * 3
          : 5 + variation * 9
  return {
    '--particle-x': `${(x * 96 + 2).toFixed(2)}%`,
    '--particle-y': `${(y * 94 + 3).toFixed(2)}%`,
    '--particle-size': `${size.toFixed(2)}px`,
    '--particle-drift': `${((sample(seed + 11) - 0.5) * 90).toFixed(2)}px`,
    '--particle-float': `${(-18 - variation * 28).toFixed(2)}px`,
    '--particle-duration': `${duration.toFixed(2)}s`,
    '--particle-delay': `${(-duration * sample(seed + 5)).toFixed(2)}s`,
    '--particle-turn': `${(variation * 360).toFixed(2)}deg`,
    '--particle-opacity': (0.48 + variation * 0.48).toFixed(2),
    '--particle-blur': index % 7 === 0 ? '0.8px' : '0px',
  } as CSSProperties
}

export default function StageEffects({ effects }: { effects: StageEffect[] }) {
  const activeEffects = effectPresets.flatMap((preset) => {
    const setting = effects.find((effect) => effect.id === preset.id && effect.enabled)
    if (!setting) return []
    const intensity = Number.isFinite(setting.intensity)
      ? Math.max(0, Math.min(1, setting.intensity))
      : 0.5
    return intensity > 0 ? [{ ...preset, intensity }] : []
  })
  if (!activeEffects.length) return null

  return (
    <div className="stage-effects" aria-hidden="true">
      {activeEffects.map((effect) => {
        const count =
          effect.id === 'aura'
            ? particleCounts.aura
            : Math.ceil(particleCounts[effect.id] * (0.25 + effect.intensity * 0.75))
        return (
          <div
            className={`stage-effect stage-effect--${effect.id}`}
            key={effect.id}
            style={{ '--effect-strength': effect.intensity } as CSSProperties}
          >
            {Array.from({ length: count }, (_, index) => (
              <i
                className="stage-effect-particle"
                key={index}
                style={particleStyle(effect.id, index)}
              >
                <b />
              </i>
            ))}
          </div>
        )
      })}
    </div>
  )
}
