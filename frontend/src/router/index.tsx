import { HashRouter, Route, Routes } from 'react-router-dom'
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
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<StudioPage />} />
        </Route>
      </Routes>
    </HashRouter>
  )
}
