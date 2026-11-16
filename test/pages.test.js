import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPageGraph, pagesFor } from "../src/pages.js";

const files = [
  { rel: "constants/routes.ts", code: `export const ROUTES = { HOME: "/home", LIST: "/list" } as const;` },
  { rel: "components/card.tsx", code: `export function Card() {\n  return <div>card</div>;\n}\nexport function Unused() { return <span /> }` },
  { rel: "pages/home.tsx", code: `import { Card } from "../components/card";\nexport default function Home() {\n  return <section><Card /></section>;\n}` },
  { rel: "pages/list.tsx", code: `import { Card } from "../components/card";\nconst List = () => <ul><Card /></ul>;\nexport default List;` },
  { rel: "pages/about.tsx", code: `export default function About() {\n  return <p>about</p>;\n}` },
  { rel: "app.tsx", code: [
    `import { createBrowserRouter } from "react-router-dom";`,
    `import Home from "./pages/home";`,
    `import List from "./pages/list";`,
    `import About from "./pages/about";`,
    `import { ROUTES } from "./constants/routes";`,
    `function Layout() {`,
    `  return <nav>menu</nav>;`,
    `}`,
    `export const router = createBrowserRouter([`,
    `  { path: "/", element: <Layout />, children: [`,
    `    { index: true, element: <Home /> },`,
    `    { path: ROUTES.HOME, element: <Home /> },`,
    `    { path: ROUTES.LIST, element: <List /> },`,
    `    { path: "about", element: <About /> },`,
    `    { path: "*", element: <About /> },`,
    `  ] },`,
    `]);`,
  ].join("\n") },
];

const g = buildPageGraph(files);

test("reads object routes, ROUTES constants, nesting and index routes", () => {
  assert.deepEqual(g.pages.map((p) => p.path).sort(), ["/about", "/home", "/list"]);
});

test("a component rendered by two pages reports both", () => {
  const r = pagesFor(g, "components/card.tsx", 2, 9);
  assert.equal(r.component, "Card");
  assert.equal(r.isPage, false);
  assert.deepEqual(r.pages.map((p) => p.path).sort(), ["/home", "/list"]);
});

test("a page's own markup reports only that page", () => {
  const r = pagesFor(g, "pages/about.tsx", 2, 9);
  assert.equal(r.isPage, true);
  assert.deepEqual(r.pages.map((p) => p.path), ["/about"]);
});

test("a layout route reaches every page beneath it", () => {
  const r = pagesFor(g, "app.tsx", 7, 9);
  assert.equal(r.component, "Layout");
  assert.equal(r.pages.length, 3);
});

test("a component no route renders reports no pages", () => {
  assert.deepEqual(pagesFor(g, "components/card.tsx", 4, 30).pages, []);
});

test("JSX <Routes> are read too", () => {
  const jsx = buildPageGraph([
    { rel: "a.tsx", code: `export function A() { return <b /> }` },
    { rel: "app.tsx", code: `import { A } from "./a";\nexport function App() {\n  return <Routes><Route path="/x" element={<A />} /></Routes>;\n}` },
  ]);
  assert.deepEqual(jsx.pages.map((p) => p.path), ["/x"]);
});
