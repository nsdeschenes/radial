export default interface CliCommandResultTypes {
  Result:
    | Readonly<{kind: 'success'; status: 0}>
    | Readonly<{kind: 'expected-failure'; status: 1 | 2}>
    | Readonly<{kind: 'interrupted'; status: 130}>;
}
