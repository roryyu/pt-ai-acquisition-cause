import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

/** ESLint Flat Config（design.md 10.2：npm run lint） */
const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [
      ".next/**",
      "out/**",
      "coverage/**",
      "next-env.d.ts",
      "lib/db/generated/**",
    ],
  },
];

export default eslintConfig;
