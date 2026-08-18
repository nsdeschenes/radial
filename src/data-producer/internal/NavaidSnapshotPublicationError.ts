export default class NavaidSnapshotPublicationError extends Error {
  readonly activeDataPreserved: boolean;

  constructor(
    activeDataPreserved: boolean,
    message = 'Navaid Snapshot publication failed.'
  ) {
    super(message);
    this.activeDataPreserved = activeDataPreserved;
  }
}
