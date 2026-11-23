/**
 * 文件职责：应用路由表。
 * 使用 HashRouter 以兼容桌面 WebView 的本地文件加载，未匹配路径回落到工作台。
 */
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import StudioLayout from '../layouts/StudioLayout'
import CodingLayout from '../layouts/CodingLayout'
import StudioPage from '../pages/StudioPage'
import CharactersPage from '../pages/CharactersPage'
import SettingsPage from '../pages/SettingsPage'

const CodingPage = lazy(() => import('../pages/CodingPage'))
const CodingPluginsPage = lazy(() => import('../pages/CodingPluginsPage'))
const CodingEnhancementsPage = lazy(() => import('../pages/CodingEnhancementsPage'))

export default function Router({
  codingWindow,
  desktop,
}: {
  codingWindow: boolean
  desktop: boolean
}) {
  return (
    <HashRouter>
      <Routes>
        {(codingWindow || !desktop) && (
          <Route path="coding" element={<CodingLayout desktopWindow={codingWindow && desktop} />}>
            <Route
              index
              element={
                <Suspense fallback={<p role="status">载入编码模式…</p>}>
                  <CodingPage />
                </Suspense>
              }
            />
            <Route
              path="plugins"
              element={
                <Suspense fallback={<p role="status">载入插件中心…</p>}>
                  <CodingPluginsPage />
                </Suspense>
              }
            />
            <Route
              path="enhancements"
              element={
                <Suspense fallback={<p role="status">载入增强设置…</p>}>
                  <CodingEnhancementsPage />
                </Suspense>
              }
            />
            <Route path="settings" element={<SettingsPage modelOnly />} />
          </Route>
        )}
        {codingWindow ? (
          <Route path="*" element={<Navigate to="/coding" replace />} />
        ) : (
          <Route element={<StudioLayout />}>
            <Route index element={<StudioPage />} />
            <Route path="coding/*" element={<Navigate to="/" replace />} />
            <Route path="characters" element={<CharactersPage />} />
            <Route path="live" element={<Navigate to="/?panel=live" replace />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<StudioPage />} />
          </Route>
        )}
      </Routes>
    </HashRouter>
  )
}
