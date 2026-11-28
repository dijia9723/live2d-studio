import { useEffect, useState } from 'react'
import { AudioLines, Copy, Radio, Square } from 'lucide-react'
import {
  outputBrowserURL,
  outputDependencies,
  type useStageOutput,
} from '../../hooks/useStageOutput'
import { notify } from '../../store/studio'
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../ui/dialog'

export default function StageOutputDialog({
  output,
}: {
  output: ReturnType<typeof useStageOutput>
}) {
  const [open, setOpen] = useState(false)
  const [microphone, setMicrophone] = useState(false)
  const [check, setCheck] = useState<{ missing: string[]; busy: boolean }>()
  const [checkError, setCheckError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const { state, start, stop, supported } = output
  const running = state.phase === 'live' || state.phase === 'starting'

  useEffect(() => {
    if (!open || !supported || running) return
    const controller = new AbortController()
    setCheck(undefined)
    setCheckError('')
    void outputDependencies(controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setCheck(result)
      },
      () => {
        if (!controller.signal.aborted) setCheckError('无法读取画布输出服务，请确认后端已更新。')
      },
    )
    return () => controller.abort()
  }, [open, supported, running, attempt])

  const copy = (value: string) => {
    if (!navigator.clipboard) {
      notify('请选中地址后手动复制。')
      return
    }
    void navigator.clipboard.writeText(value).then(
      () => notify('已复制地址'),
      () => notify('复制失败，请选中地址后手动复制。'),
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" aria-label="画布输出" aria-pressed={state.phase === 'live'}>
          <Radio size={15} aria-hidden="true" />
          {state.phase === 'live' ? '输出中' : '画布输出'}
        </button>
      </DialogTrigger>
      <DialogContent className="w-[490px] space-y-4 rounded-2xl border border-border bg-white p-5 shadow-xl">
        <div className="space-y-1.5 pr-5">
          <DialogTitle>画布输出</DialogTitle>
          <DialogDescription>把舞台画面和声音送到 OBS 或抖音直播伴侣。</DialogDescription>
        </div>
        {supported ? (
          <>
            <p className="text-sm text-muted-foreground">
              在共享窗口中选择当前 Live2D Studio 标签页，并勾选分享标签页音频。
            </p>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={microphone}
                disabled={running}
                onChange={(event) => setMicrophone(event.target.checked)}
              />
              <AudioLines size={16} aria-hidden="true" />
              同时混入麦克风
            </label>
          </>
        ) : (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>请在桌面版 Chrome 或 Edge 中打开工作台，再启动画布输出。</p>
            <input
              aria-label="浏览器工作台地址"
              className="w-full rounded-md border border-border px-2 py-1.5"
              readOnly
              value={outputBrowserURL()}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="button ghost" onClick={() => copy(outputBrowserURL())}>
              <Copy size={14} /> 复制工作台地址
            </button>
          </div>
        )}
        {supported && !running && (
          <div className="flex items-center justify-between gap-3 text-sm">
            <p role="status" className="text-muted-foreground">
              {checkError ||
                (check?.missing.length
                  ? `请安装 ${check.missing.join('、')}，并将程序放到 PATH 或 Studio 程序同目录。`
                  : check?.busy
                    ? '另一个窗口可能正在输出。'
                    : check
                      ? ''
                      : '正在检查本机转码工具…')}
            </p>
            {(checkError || !!check?.missing.length || check?.busy) && (
              <button
                type="button"
                className="button ghost shrink-0"
                onClick={() => setAttempt(attempt + 1)}
              >
                重新检测
              </button>
            )}
          </div>
        )}
        {state.phase === 'error' && (
          <p className="panel-error" role="alert">
            {state.message}
          </p>
        )}
        {state.phase === 'starting' && (
          <p role="status" className="text-sm text-muted-foreground">
            等待共享画布并启动编码…
          </p>
        )}
        {state.phase === 'live' && (
          <div className="space-y-3">
            {(
              [
                ['RTSP', state.sources.rtsp],
                ['RTMP', state.sources.rtmp],
                ['HLS', state.sources.hls],
                ['网页播放器', new URL('./?muted=false', state.sources.hls).href],
              ] as const
            ).map(([label, url]) => (
              <label key={label} className="block text-xs text-muted-foreground">
                {label}
                <span className="mt-1 flex gap-2">
                  <input
                    readOnly
                    className="min-w-0 flex-1 rounded-md border border-border px-2 py-1.5 font-mono text-foreground"
                    value={url}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    className="button ghost"
                    aria-label={`复制${label}地址`}
                    onClick={() => copy(url)}
                  >
                    <Copy size={14} />
                  </button>
                </span>
              </label>
            ))}
            <p className="text-xs leading-relaxed text-muted-foreground">
              OBS 添加「媒体源」，取消「本地文件」，填入 RTSP
              地址。抖音直播伴侣可在支持的网页素材中填入播放器地址，并确认音量已打开。
            </p>
            <p className="text-xs text-muted-foreground">输出期间请保持当前标签页打开。</p>
          </div>
        )}
        {supported && (
          <div className="flex justify-end gap-2">
            {running ? (
              <button type="button" className="button danger" onClick={stop}>
                <Square size={14} /> {state.phase === 'live' ? '停止输出' : '取消'}
              </button>
            ) : (
              <button
                type="button"
                className="button primary"
                disabled={!check || !!check.missing.length}
                onClick={() => void start(microphone)}
              >
                <Radio size={14} /> 开始输出
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
