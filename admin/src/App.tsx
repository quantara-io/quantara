import { BrowserRouter, Routes, Route } from "react-router-dom";

import { AuthGate } from "./components/AuthGate";
import { Layout } from "./components/Layout";
import { Genie } from "./pages/Genie";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Market } from "./pages/Market";
import { News } from "./pages/News";
import { Whitelist } from "./pages/Whitelist";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <AuthGate>
              <Layout>
                <Overview />
              </Layout>
            </AuthGate>
          }
        />
        <Route
          path="/market"
          element={
            <AuthGate>
              <Layout>
                <Market />
              </Layout>
            </AuthGate>
          }
        />
        <Route
          path="/news"
          element={
            <AuthGate>
              <Layout>
                <News />
              </Layout>
            </AuthGate>
          }
        />
        <Route
          path="/whitelist"
          element={
            <AuthGate>
              <Layout>
                <Whitelist />
              </Layout>
            </AuthGate>
          }
        />
        <Route
          path="/genie"
          element={
            <AuthGate>
              <Layout>
                <Genie />
              </Layout>
            </AuthGate>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
