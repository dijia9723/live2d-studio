/**
 * 文件职责：应用路由表。
 * 使用 HashRouter 以兼容桌面 WebView 的本地文件加载，未匹配路径回落到工作台。
 */
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import StudioLayout from '../layouts/StudioLayout'
import StudioPage from '../pages/StudioPage'
import CharactersPage from '../pages/CharactersPage'
import SettingsPage from '../pages/SettingsPage'

export default function Router() {
  return (
    <HashRouter>
      <Routes>
        <Route element={<StudioLayout />}>
          <Route index element={<StudioPage />} />
          <Route path="characters" element={<CharactersPage />} />
          <Route path="live" element={<Navigate to="/?panel=live" replace />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<StudioPage />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
