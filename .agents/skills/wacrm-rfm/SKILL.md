```markdown
# wacrm-rfm Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `wacrm-rfm` TypeScript codebase. It covers file naming, import/export styles, commit message conventions, and testing patterns. By following these guidelines, contributors can maintain consistency and quality across the project.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `userProfile.ts`, `rfmCalculator.ts`

### Imports
- Use **alias imports** for modules.
  - Example:
    ```typescript
    import { calculateRFM as rfm } from './rfmCalculator';
    ```

### Exports
- Use **named exports**.
  - Example:
    ```typescript
    // In rfmCalculator.ts
    export function calculateRFM(data: DataType): RFMResult { ... }
    ```

### Commit Messages
- Follow **Conventional Commits**.
- Use prefixes like `feat` for new features and `fix` for bug fixes.
  - Example:
    ```
    feat: add RFM calculation for new customer segment
    fix: correct date parsing in transaction history
    ```

## Workflows

### Code Contribution
**Trigger:** When adding new features or fixing bugs  
**Command:** `/contribute`

1. Create a new branch from `main`.
2. Implement your changes following the coding conventions.
3. Write or update tests as necessary.
4. Commit changes using conventional commit messages.
5. Push your branch and open a pull request.

### Testing Code
**Trigger:** When verifying code correctness  
**Command:** `/test`

1. Locate or create test files matching `*.test.*`.
2. Run the test suite using the project's test runner (framework unknown; refer to project scripts).
3. Ensure all tests pass before submitting changes.

## Testing Patterns

- Test files follow the pattern: `*.test.*`
  - Example: `rfmCalculator.test.ts`
- The testing framework is not specified; check project scripts or documentation for details.
- Place tests alongside the modules they cover or in a dedicated `tests` directory.

## Commands
| Command      | Purpose                                    |
|--------------|--------------------------------------------|
| /contribute  | Start the code contribution workflow       |
| /test        | Run the test suite                        |
```
