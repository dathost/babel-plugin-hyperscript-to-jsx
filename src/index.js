"use strict";

const t = require("@babel/core").types;
const declare = require("@babel/helper-plugin-utils").declare;
const getTagAndClassNamesAndId = require("./utils").getTagAndClassNamesAndId;
const revTransform = require("./rev");
const getOption = require("./utils").getOption;
let isHyperscriptInScope = false;
// utility functions that starts with b means build.

const transformProps = props => {
  for (const prop of props) {
    if (prop.name.name === 'class') {
      prop.name.name = 'className';
    } else if (prop.name.name === 'for') {
      prop.name.name = 'htmlFor';
    } else if (prop.name.name === 'style') {
      const style = prop.value.value;
      if (typeof style === "string") {
        prop.value = t.JSXExpressionContainer(
          t.objectExpression(
            style.split(";").map((s) => {
              let [key, val] = s.split(":");
              key = (key || "").trim();
              val = (val || "").trim();

              if (!key.trim()) {
                return null;
              }

              return t.objectProperty(
                t.stringLiteral(key.replace(/-./g, (x) => x[1].toUpperCase())),
                !val.includes(' ') && !isNaN(val.split('px')[0]) ?
                  t.numericLiteral(parseFloat(val.split('px')[0]))
                  : t.stringLiteral(val),
              )
            }).filter(Boolean)
          )
        );
      }
    }
  }

  return props
}

const isHyperscriptCall = node => {
  return t.isIdentifier(node.callee, {
    name: "h"
  });
};

const bJsxAttr = (prop, expressionOrValue) => {
  const attributeName = t.isStringLiteral(prop)
    ? prop.extra.rawValue
    : prop.name;
  const stringOrExpression = t.isStringLiteral(expressionOrValue)
    ? expressionOrValue
    : t.JSXExpressionContainer(expressionOrValue);
  return t.JSXAttribute(bJsxIdent(attributeName), stringOrExpression);
};

const bJsxAttributes = objectExpression => {
  return objectExpression.properties.map(node => {
    const { key, value, argument } = node;
    if (t.isSpreadElement(node) || t.isSpreadElement(node)) {
      return t.JSXSpreadAttribute(argument);
    } else if (t.isProperty(node) && node.computed && !t.isStringLiteral(key)) {
      // to handle h(Abc, { [kek]: 0, ["norm"]: 1 }) to <Abc {...{ [kek]: 0 }} norm={1} />
      return t.JSXSpreadAttribute(t.objectExpression([node]));
    } else {
      return bJsxAttr(key, value);
    }
  });
};

const bJsxOpenElem = ({ name, selfClosing = false, attributes = [] }) =>
  t.JSXOpeningElement(
    t.isJSXMemberExpression(name) ? name : bJsxIdent(name),
    attributes,
    selfClosing
  );

const bJsxIdent = name => t.JSXIdentifier(name);

const bJsxCloseElem = name =>
  t.isJSXMemberExpression(name)
    ? t.JSXClosingElement(name)
    : t.JSXClosingElement(bJsxIdent(name));

// Builds self closed element
const bJsxElem = ({
  name = "div",
  attributes = [],
  children = [],
  selfClosing = false
}) =>
  t.JSXElement(
    bJsxOpenElem({ attributes, name, selfClosing }),
    selfClosing ? null : bJsxCloseElem(name),
    children,
    selfClosing
  );

// Makes component wrap around his children, so closes it around strings/JSXElements/expressions.
const closeComponent = (jsxElem, children) => {
  const { name } = jsxElem.openingElement;
  jsxElem.selfClosing = false;
  jsxElem.openingElement.selfClosing = false;
  jsxElem.closingElement = bJsxCloseElem(
    t.isJSXMemberExpression(name) ? name : name.name
  );
  jsxElem.children = children;
  return jsxElem;
};

const injectChildren = (jsxElem, node) => {
  if (isHyperscriptCall(node)) {
    return closeComponent(jsxElem, [transformHyperscriptToJsx(node, false)]);
  }
  if (t.isArrayExpression(node)) {
    return closeComponent(jsxElem, transformChildrenArray(node));
  }
  if (t.isStringLiteral(node)) {
    return closeComponent(jsxElem, [t.JSXText(node.value)]);
  }
  if (t.isExpression(node)) {
    return closeComponent(jsxElem, [t.JSXExpressionContainer(node)]);
  }
};

const transformChildrenArray = node => {
  return node.elements.map(element => {
    if (isHyperscriptCall(element)) {
      return transformHyperscriptToJsx(element, false);
    }
    if (t.isStringLiteral(element)) {
      return t.JSXText(element.value);
    }
    if (t.isExpression(element)) {
      return t.JSXExpressionContainer(element);
    }
  });
};

const convertToStringLiteral = node =>
  t.stringLiteral(node.quasis[0].value.raw);

const transformHyperscriptToJsx = (node, isTopLevelCall) => {
  // Intermediate cause first need to be checked on some corner cases
  const [intermediateFirstArg, secondArg, thirdArg] = node.arguments;
  // Handling few corner cases down here

  // Handling of h(obj[field]) or h(fn()) and h(`stuff ${computed}`) to ignore and convert to StringLiteral if possible
  const isTemplateLiteral = t.isTemplateLiteral(intermediateFirstArg);
  const hasExpressions =
    isTemplateLiteral && intermediateFirstArg.expressions.length;
  const isComputedClassNameOrComponent =
    intermediateFirstArg.computed ||
    hasExpressions ||
    t.isBinaryExpression(intermediateFirstArg);
  const isFirstArgIsCalledFunction =
    intermediateFirstArg.arguments &&
    intermediateFirstArg.arguments.length >= 0;
  // Intermediate value to convert to StringLiteral if TemplateLiteral has no expressions
  const firstArgument =
    isTemplateLiteral && !hasExpressions
      ? convertToStringLiteral(intermediateFirstArg)
      : intermediateFirstArg;
  const isFirstArgIsConditionalExpression =
    firstArgument.type === "ConditionalExpression";

  // If firstArg is computed should be ignored, but inside the JSX should be wrapped into JSXExprContainer
  if (
    isComputedClassNameOrComponent ||
    isFirstArgIsCalledFunction ||
    isFirstArgIsConditionalExpression
  ) {
    return isTopLevelCall ? node : t.JSXExpressionContainer(node);
  }

  switch (node.arguments.length) {
    case 1:
      return singleArgumentCase(firstArgument);
    case 2:
      return twoArgumentsCase(firstArgument, secondArg, true);
    case 3:
      return threeArgumentsCase(firstArgument, secondArg, thirdArg);
    default:
      return manyArgumentsCase(firstArgument, secondArg, node.arguments.slice(2));
  }
};

const memberExpressionToJsx = memberExpression => {
  const object = t.isMemberExpression(memberExpression.object)
    ? memberExpressionToJsx(memberExpression.object)
    : bJsxIdent(memberExpression.object.name);
  const property = bJsxIdent(memberExpression.property.name);
  return t.jSXMemberExpression(object, property);
};

const singleArgumentCase = firstArgument => {
  const isElement = t.isStringLiteral(firstArgument);
  const isReactComponent = t.isIdentifier(firstArgument);
  const isMemberExpression = t.isMemberExpression(firstArgument);
  let attributes = [];
  if (isElement) {
    const { id, className, tag } = getTagAndClassNamesAndId(
      firstArgument.value
    );
    className &&
      attributes.push(
        bJsxAttr(t.JSXIdentifier("className"), t.StringLiteral(className))
      );
    id && attributes.push(bJsxAttr(t.JSXIdentifier("id"), t.StringLiteral(id)));
    return bJsxElem({
      selfClosing: true,
      name: tag,
      attributes
    });
  } else if (isReactComponent || isMemberExpression) {
    const componentName = isMemberExpression
      ? memberExpressionToJsx(firstArgument)
      : firstArgument.name;
    return bJsxElem({
      selfClosing: true,
      name: componentName
    });
  }
};

const twoArgumentsCase = (firstArg, secondArg, thirdArgIsAbsent) => {
  const jsxElem = singleArgumentCase(firstArg);
  const isPropsObject = t.isObjectExpression(secondArg) || t.isNullLiteral(secondArg);
  if (isPropsObject) {
    const props = t.isNullLiteral(secondArg) ? [] : bJsxAttributes(secondArg);
    const currentProps = jsxElem.openingElement.attributes;
    jsxElem.openingElement.attributes = [...currentProps, ...transformProps(props)];
    return jsxElem;
  }
  if (thirdArgIsAbsent) {
    return injectChildren(jsxElem, secondArg);
  } else {
    jsxElem.openingElement.attributes.push(t.JSXSpreadAttribute(secondArg));
    return jsxElem;
  }
};

const threeArgumentsCase = (firstArg, secondArg, thirdArg) => {
  const jsxElem = twoArgumentsCase(firstArg, secondArg, false);
  return injectChildren(jsxElem, thirdArg);
};

const manyArgumentsCase = (firstArg, secondArg, elements) => {
  const jsxElem = twoArgumentsCase(firstArg, secondArg, false);
  return closeComponent(jsxElem, transformChildrenArray({ elements }));
};

let isCssModules = false;
module.exports = declare(api => {
  return {
    name: "hyperscript-to-jsx",
    manipulateOptions(opts, parserOpts) {
      parserOpts.plugins.push("asyncGenerators");
      parserOpts.plugins.push("classProperties");
      parserOpts.plugins.push("decorators-legacy");
      parserOpts.plugins.push("doExpressions");
      parserOpts.plugins.push("dynamicImport");
      parserOpts.plugins.push("flow");
      parserOpts.plugins.push("functionBind");
      parserOpts.plugins.push("functionSent");
      parserOpts.plugins.push("jsx");
      parserOpts.plugins.push("objectRestSpread");
      parserOpts.plugins.push("exportDefaultFrom");
      parserOpts.plugins.push("exportNamespaceFrom");
    },
    visitor: {
      Program(path) {
        isHyperscriptInScope = path.node.body.find(arg => {
          if (t.isVariableDeclaration(arg)) {
            return (
              arg.declarations.find(
                declaration => declaration.id.name === "h"
              ) || false
            );
          }
          if (t.isImportDeclaration(arg)) {
            return (
              arg.specifiers.find(specifier => specifier.local.name === "h") ||
              false
            );
          }
        });
      },
      CallExpression(path, state) {
        if (isHyperscriptInScope) {
          const { node } = path;
          const isTopLevelCall =
            t.isReturnStatement(path.container) || // return h()
            t.isConditionalExpression(path.container) || // stuff ? h() : h()
            t.isArrowFunctionExpression(path.container) || // () => h()
            t.isLogicalExpression(path.container) || // stuff && h()
            t.isObjectProperty(path.container) || // { property: h() }
            t.isVariableDeclarator(path.container) || // const a = h()
            t.isExpressionStatement(path.container) || // h() <------ stand alone without assignment etc
            t.isJSXExpressionContainer(path.container) || // <div>{h()}</div>
            t.isAssignmentExpression(path.container) || // reassignMe = h()
            t.isArrayExpression(path.parent); // [h()]
          if (isHyperscriptCall(node) && isTopLevelCall) {
            let result = node;
            const isRevolut = getOption(state, "revolut", false);
            result = isRevolut
              ? revTransform(node, isTopLevelCall, !!isCssModules)
              : transformHyperscriptToJsx(node, isTopLevelCall);
            path.replaceWith(result);
          }
        }
      }
    }
  };
});
