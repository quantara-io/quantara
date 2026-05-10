import type { ReactNode } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AuthGate } from "./components/AuthGate";
import { Layout } from "./components/Layout";
import { Activity } from "./pages/Activity";
import { Genie } from "./pages/Genie";
import { Glossary } from "./pages/Glossary";
import { Health } from "./pages/Health";
import { Login } from "./pages/Login";
import { Market } from "./pages/Market";
import { News } from "./pages/News";
import { Ops } from "./pages/Ops";
import { Performance } from "./pages/Performance";
import { Pipeline } from "./pages/Pipeline";
import { Pnl } from "./pages/Pnl";
import { Ratifications } from "./pages/Ratifications";
import { Whitelist } from "./pages/Whitelist";
import { Workstation } from "./pages/Workstation";

interface PageProps {
  children: ReactNode;
  bleed?: boolean;
}

function Page({ children, bleed }: PageProps) {
  return (
    <AuthGate>
      <Layout bleed={bleed}>{children}</Layout>
    </AuthGate>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <Page bleed>
              <Workstation />
            </Page>
          }
        />
        <Route
          path="/ops"
          element={
            <Page>
              <Ops />
            </Page>
          }
        />
        <Route
          path="/market"
          element={
            <Page>
              <Market />
            </Page>
          }
        />
        <Route
          path="/news"
          element={
            <Page>
              <News />
            </Page>
          }
        />
        <Route
          path="/whitelist"
          element={
            <Page>
              <Whitelist />
            </Page>
          }
        />
        <Route
          path="/ratifications"
          element={
            <Page>
              <Ratifications />
            </Page>
          }
        />
        <Route
          path="/genie"
          element={
            <Page>
              <Genie />
            </Page>
          }
        />
        <Route
          path="/performance"
          element={
            <Page>
              <Performance />
            </Page>
          }
        />
        <Route
          path="/pipeline"
          element={
            <Page>
              <Pipeline />
            </Page>
          }
        />
        <Route
          path="/health"
          element={
            <Page>
              <Health />
            </Page>
          }
        />
        <Route
          path="/activity"
          element={
            <Page>
              <Activity />
            </Page>
          }
        />
        <Route
          path="/pnl"
          element={
            <Page>
              <Pnl />
            </Page>
          }
        />
        <Route
          path="/admin/glossary"
          element={
            <Page>
              <Glossary />
            </Page>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
