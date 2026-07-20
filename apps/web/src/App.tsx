import DashboardPage from "./pages/DashboardPage";
import OrdersPage from "./pages/OrdersPage";
import PlaygroundPage from "./pages/PlaygroundPage";

const PAGES = {
  "/dashboard": DashboardPage,
  "/orders": OrdersPage,
  "/playground": PlaygroundPage,
} as const;

/** Renders one of Chatty's three thin FastAPI client pages. */
export function App() {
  const Page =
    PAGES[window.location.pathname as keyof typeof PAGES] ?? PlaygroundPage;

  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <Page />
    </>
  );
}
