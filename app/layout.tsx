import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '上皮 ONSTAGE · 少女乐队对戏',
  description: 'MyGO!!!!! 与 Ave Mujica 的多人文字对戏空间。',
  icons: { icon: '/static/onstage-mark.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
