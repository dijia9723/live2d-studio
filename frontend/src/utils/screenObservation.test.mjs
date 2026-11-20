import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeScreen,
  describeScreenChange,
  needsScreenImage,
  screenQuestionIntent,
} from './screenObservation.ts'

const line = (text, x = 0, y = 0) => ({ text, bounds: { x, y, w: 0.35, h: 0.03 } })

test('screen questions prioritize matching Chinese text and reported errors', () => {
  const lines = [line('系统设置'), line('没有访问权限'), line('部署状态正常')]
  assert.match(describeScreen(lines, [], '为什么没有访问权限？'), /^当前可见文字：没有访问权限/)
  assert.match(describeScreen(lines, [], '这次报错了什么？'), /^当前可见文字：没有访问权限/)
})

test('pointing prefers the line under the pointer and screen history has its own budget', () => {
  const history = ['出现错误提示「403 Access Denied」']
  const lines = Array.from({ length: 16 }, (_, index) =>
    line(`日志${index} ${'消息'.repeat(80)}`, 0, index / 20),
  )
  lines.push(line('保存并继续', 0.6, 0.8))
  assert.match(
    describeScreen(lines, [], '这个是什么？', { x: 0.9, y: 0.81 }),
    /^当前可见文字：保存并继续/,
  )
  assert.match(describeScreen(lines, history, '看看页面'), /近期变化.*403 Access Denied/)
  assert.match(describeScreen(lines, history, '刚才发生了什么？'), /^近期变化.*403 Access Denied/)
})

test('newly recognized errors are reported once in a change', () => {
  const event = describeScreenChange([line('正常')], [line('错误 403'), line('重新登录')])
  assert.equal(event, '出现错误提示「错误 403」；新增「重新登录」；消失「正常」')
})

test('location questions get the approximate place of the visible text', () => {
  assert.match(
    describeScreen([line('重新登录', 0.58, 0.72)], [], '重新登录按钮在哪？'),
    /\[右下\]重新登录/,
  )
})

test('short follow-ups use screen context only after a screen question', () => {
  for (const question of ['那怎么处理？', '为什么？', '现在好了没有？', 'So, how do I fix it?']) {
    assert.equal(screenQuestionIntent(question, false), undefined)
    assert.equal(screenQuestionIntent(question, true), 'follow-up')
  }
  for (const question of [
    '现在几点？',
    '这个故事讲了什么？',
    '那讲个笑话吧',
    'tell me about this story',
  ]) {
    assert.equal(screenQuestionIntent(question, true), undefined)
  }
  assert.equal(screenQuestionIntent('刚才显示了什么错误？', false), 'recent')
  assert.equal(screenQuestionIntent('这行显示什么？', false), 'current')
  assert.equal(screenQuestionIntent('应该点哪个？', true), 'follow-up')
})

test('questions about screenshot text stay on OCR while layout questions can ask for a crop', () => {
  assert.equal(needsScreenImage('截图里报了什么错？'), false)
  assert.equal(needsScreenImage('图片里的错误码是什么？'), false)
  assert.equal(needsScreenImage('这个图标是什么颜色？'), true)
  assert.equal(needsScreenImage('截图里的文字是什么颜色？'), true)
  assert.equal(needsScreenImage('发一下截图'), true)
})
