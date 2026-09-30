import ts from "typescript";

/** Test-only static guard for the JSON arguments consumed by a registered handler. */
export function scanHandlerArgs(text: string, handler: string): Set<string> {
  const source = ts.createSourceFile("handler.ts", text, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  const functions = new Map<string, ts.FunctionLikeDeclaration>();
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    if (ts.isFunctionExpression(node) && node.name) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, walk);
  };
  walk(source);

  const unwrap = (expr: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) ||
      ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      expr = expr.expression;
    }
    return expr;
  };
  const isAlias = (expr: ts.Expression, aliases: Set<string>): boolean => {
    const target = unwrap(expr);
    return ts.isIdentifier(target) && aliases.has(target.text);
  };
  const scan = (body: ts.Node, initial: Set<string>, active = new Set<ts.Node>()): void => {
    if (active.has(body)) return;
    active.add(body);
    const aliases = new Set(initial);
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer && isAlias(node.initializer, aliases)) {
        if (ts.isIdentifier(node.name)) aliases.add(node.name.text);
        if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (element.dotDotDotToken || !ts.isIdentifier(element.name)) throw new Error("dynamic args destructuring requires explicit schema review");
            const key = element.propertyName ?? element.name;
            if (!ts.isIdentifier(key) && !ts.isStringLiteral(key)) throw new Error("dynamic args key requires explicit schema review");
            names.add(key.text);
          }
        }
      }
      if (ts.isPropertyAccessExpression(node) && isAlias(node.expression, aliases)) names.add(node.name.text);
      if (ts.isElementAccessExpression(node) && isAlias(node.expression, aliases)) {
        const key = node.argumentExpression;
        if (!ts.isStringLiteral(key) && !ts.isNumericLiteral(key)) throw new Error("dynamic args key requires explicit schema review");
        names.add(key.text);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = functions.get(node.expression.text);
        if (callee?.body) {
          const forwarded = new Set<string>();
          node.arguments.forEach((arg, index) => {
            if (isAlias(arg, aliases)) {
              const param = callee.parameters[index]?.name;
              if (param && ts.isIdentifier(param)) forwarded.add(param.text);
            }
          });
          if (forwarded.size) scan(callee.body, forwarded, active);
        }
      }
      // A nested function has its own parameters: do not attribute a shadowed args to this handler.
      if (node !== body && ts.isFunctionLike(node) && node.parameters.some(p => ts.isIdentifier(p.name) && aliases.has(p.name.text))) return;
      ts.forEachChild(node, visit);
    };
    visit(body);
    active.delete(body);
  };

  if (handler === "remember" || handler === "recall") {
    const findRegistration = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "registerAction" &&
        ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === handler) {
        const fn = node.arguments[1];
        if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) scan(fn.body, new Set(["args"]));
      }
      ts.forEachChild(node, findRegistration);
    };
    findRegistration(source);
  } else if (handler === "makeTodo") {
    const fn = functions.get(handler);
    const findHandler = (node: ts.Node): void => {
      if (ts.isArrowFunction(node) && node.parameters.some(p => ts.isIdentifier(p.name) && p.name.text === "args")) {
        scan(node.body, new Set(["args"]));
      } else ts.forEachChild(node, findHandler);
    };
    if (fn?.body) findHandler(fn.body);
  } else {
    const fn = functions.get(handler);
    if (fn?.body) {
      const arg = fn.parameters.find(p => ts.isIdentifier(p.name) && (p.name.text === "args" ||
        (handler === "importSessions" && p.name.text === "opts") ||
        (["scopeOf", "removedMemoryScope"].includes(handler) && p.name.text === "a")));
      if (arg && ts.isIdentifier(arg.name)) scan(fn.body, new Set([arg.name.text]));
    }
  }
  if (!["remember", "recall"].includes(handler) && !functions.has(handler)) {
    throw new Error(`handler ${handler} not found`);
  }
  return names;
}
