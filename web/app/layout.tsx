import type { Metadata } from 'next';
import './globals.css';
export const metadata:Metadata={title:'Authz Agent · 授权分析工作台',description:'以源码证据驱动的授权分析工作台'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>;}
