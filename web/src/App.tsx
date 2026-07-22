import WorkbenchPage from './features/WorkbenchPage'

/** Renders Chatty's single Workbench page behind a skip link. */
export function App() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <WorkbenchPage />
    </>
  )
}
