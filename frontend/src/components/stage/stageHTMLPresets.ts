import aurora from '../../assets/stage-presets/aurora.html?raw'
import neonCity from '../../assets/stage-presets/neon-city.html?raw'
import orbital from '../../assets/stage-presets/orbital.html?raw'
import meteors from '../../assets/stage-presets/meteors.html?raw'
import hologram from '../../assets/stage-presets/hologram.html?raw'
import glowDust from '../../assets/stage-presets/glow-dust.html?raw'

export interface StageHTMLPreset {
  id: string
  name: string
  source: string
}

export const backgroundHTMLPresets: StageHTMLPreset[] = [
  { id: 'builtin:aurora', name: '极光雪岭', source: aurora },
  { id: 'builtin:neon-city', name: '霓虹天际线', source: neonCity },
  { id: 'builtin:orbital', name: '星环深空', source: orbital },
]

export const overlayHTMLPresets: StageHTMLPreset[] = [
  { id: 'builtin:meteors', name: '流星雨', source: meteors },
  { id: 'builtin:hologram', name: '全息扫描', source: hologram },
  { id: 'builtin:glow-dust', name: '浮光粒子', source: glowDust },
]
