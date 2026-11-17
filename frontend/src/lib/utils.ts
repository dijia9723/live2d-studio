/** 文件职责：className 合并工具，供 shadcn/ui 组件统一处理条件类名与冲突。 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 合并类名：先拼接条件类名，再用 tailwind-merge 去掉重复的 Tailwind 工具类。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
