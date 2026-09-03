#!/usr/bin/env node
/* Builds each page vite knows how to build. The page is named by an
   environment variable, which npm scripts cannot set in a way every shell
   agrees on, so it is set here and vite is asked to build directly. */
import { build } from "vite";

for (const page of ["shortcuts", "import"]) {
  process.env.TODE_PAGE = page;
  await build();
}
