import { LinkOutlined } from '@ant-design/icons'

export function SiteFooter() {
  return <footer className="site-footer app-footer">
    <span>© xcodex Remote</span>
    <div className="site-footer-links">
      <a href="/" className="site-footer-link"><LinkOutlined aria-hidden="true" /><span>返回首页</span></a>
      <a href="https://xcodex.vip" target="_blank" rel="noreferrer" className="site-footer-link">xcodex 官网</a>
      <a href="https://xcodex.vip/connect?editor=deepseek" target="_blank" rel="noreferrer" className="site-footer-link">连接指南</a>
    </div>
  </footer>
}
