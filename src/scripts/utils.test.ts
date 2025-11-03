import { DependencyUtils, parseDepFilename } from './utils';

describe('DependencyUtils.extractRawImportsWithBabel', () => {
  describe('Should NOT match imports inside strings', () => {
    test('should NOT match import inside double-quoted string', () => {
      const code = `const str = "import x from './module'";`;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual([]);
    });

    test('should NOT match error messages with import keywords', () => {
      const code = `throw new Error("'import' and 'export' may appear only with 'sourceType: \\"module\\"'");`;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual([]);
    });

    test('should NOT match @babel/parser error messages', () => {
      const code = `
        ImportOutsideModule: {
          message: \`'import' and 'export' may appear only with 'sourceType: "module"'\`,
          code: ve,
        }
      `;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual([]);
    });
  });

  describe('Should match actual imports', () => {
    test('should match standard import statements', () => {
      const code = `import foo from "bar";`;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual(['bar']);
    });

    test('should match dynamic imports', () => {
      const code = `const module = import("./module");`;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual(['./module']);
    });

    test('should match export from statements', () => {
      const code = `export { foo } from "bar";`;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual(['bar']);
    });

    test('should only match actual imports, not quoted ones', () => {
      const code = `
        import real from "./real-module";
        const fake = "'import' is not allowed";
        export { something } from "./another-real";
      `;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual(['./real-module', './another-real']);
    });
  });

  describe('Edge cases', () => {
    test('should handle JSX syntax', () => {
      const code = `
        import React from "react";
        const Component = () => <div>Hello</div>;
      `;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual(['react']);
    });

    test('should handle TypeScript syntax', () => {
      const code = `
        import type { Foo } from "bar";
        import { baz } from "qux";
      `;
      const imports = DependencyUtils.extractRawImportsWithBabel(code);
      expect(imports).toEqual(['bar', 'qux']);
    });
  });
});

describe('parseDepFilename helper', () => {
  test('parses filename with peer context', () => {
    const info = parseDepFilename('framer-motion@10.16.16_react-18.1.0_006ab095.js');
  expect(info).not.toBeNull();
  expect(info!.baseDepNameVersion).toBe('framer-motion@10.16.16');
  expect(info!.peerContext).toEqual(['react@18.1.0']);
  });

  test('parses filename without peer context', () => {
    const info = parseDepFilename('react@19.2.0_165279c2.js');
  expect(info).not.toBeNull();
  expect(info!.baseDepNameVersion).toBe('react@19.2.0');
  expect(info!.peerContext).toEqual([]);
  });

  test('parses scoped package filename', () => {
    const info = parseDepFilename('@antfu-ni@25.0.0_e59d44ed.js');
  expect(info).not.toBeNull();
  expect(info!.baseDepNameVersion).toBe('@antfu/ni@25.0.0');
  expect(info!.peerContext).toEqual([]);
  });

  test('parses latest tag filename', () => {
    const info = parseDepFilename('node@latest_00eee0fc.js');
  expect(info).not.toBeNull();
  expect(info!.baseDepNameVersion).toBe('node@latest');
  expect(info!.peerContext).toEqual([]);
  });
});