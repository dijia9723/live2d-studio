/**
 * 文件职责：前端入口，挂载 React 根节点并加载全局样式。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// Tailwind/shadcn 入口同时按 legacy 层引入原有样式，统一保证层叠顺序。
import './assets/tailwind.css'

const pet = new URLSearchParams(window.location.search).get('pet') === '1'
document.documentElement.classList.toggle('pet-document', pet)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App pet={pet} />
  </React.StrictMode>,
)
