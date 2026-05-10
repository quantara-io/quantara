import { BrowserRouter, Routes, Route } from "react-router-dom";

import { AuthGate } from "./components/AuthGate";
import { Layout } from "./components/Layout";
import { Activity } from "./pages/Activity";
import { Genie } from "./pages/Genie";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Market } from "./pages/Market";
import { News } from "./pages/News";
import { Pipeline } from "./pages/Pipeline";
import { Whitelist } from "./pages/Whitelist";
import { Ratifications } from "./pages/Ratifications";
import { Pnl } from "./pages/Pnl";

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
          path="/ratifications"
          element={
            <AuthGate>
              <Layout>
                <Ratifications />
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
        <Route
          path="/pipeline"
          element={
            <AuthGate>
              <Layout>
                <Pipeline />
              </Layout>
            </AuthGate>
          }
        />
        <Route
          path="/activity"
          element={
            <AuthGate>
              <Layout>
                <Activity />
              </Layout>
            </AuthGate>
          }
        />
        <Route
          path="/pnl"
          element={
            <AuthGate>
              <Layout>
                <Pnl />
              </Layout>
            </AuthGate>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
