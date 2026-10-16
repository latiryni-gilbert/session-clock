// Lets tests read a file's text with `import text from './file?raw'` (the bundler supports it).
declare module '*?raw' {
  const content: string
  export default content
}
