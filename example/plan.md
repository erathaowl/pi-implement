# Pi Implement Smoke Test Plan

Create a small deterministic smoke-test workspace under `.pi-implement-smoke/`.

The implementation must:

- modify files only inside `.pi-implement-smoke/`;
- use no external dependencies;
- avoid remote Git operations;
- consist of 20 small sequential tasks;
- keep each task independent, simple, and quick to execute.

## Required implementation steps

1. Create `.pi-implement-smoke/`.
2. Create `README.md` with `# Pi Implement Smoke Test`.
3. Append `Temporary files used to test sequential task execution.` to `README.md`.
4. Create `hello.txt` containing `hello`.
5. Append `world` to `hello.txt`.
6. Create `data.json` with:
   - `"name": "smoke-test"`
   - `"enabled": true`
7. Add `"version": 1` to `data.json`.
8. Create `example.py` with a `hello()` function returning `"hello"`.
9. Add `add(a, b)` returning `a + b` to `example.py`.
10. Add `VERSION = 1` to `example.py`.
11. Create `example.js` containing `export const enabled = true;`.
12. Add an exported `add(a, b)` function returning `a + b` to `example.js`.
13. Create `config.yaml` containing `enabled: true`.
14. Add `name: smoke-test` to `config.yaml`.
15. Create `items.txt` with:
    - `one`
    - `two`
    - `three`
16. Append `four` to `items.txt`.
17. Create `checklist.md` with three unchecked Markdown items: Alpha, Beta, Gamma.
18. Mark Alpha as checked.
19. Create `status.txt` containing `tasks nearly complete`.
20. Replace its contents with `smoke test complete`.

## Acceptance criteria

The generated task document should preserve these 20 operations as separate top-level tasks, in the same order, without merging them.

