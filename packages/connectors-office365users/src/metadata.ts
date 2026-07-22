/**
 * Office 365 Users Connector Metadata
 *
 * Defines all Office 365 Users operations with their parameters and documentation.
 * Used by the language service for completions and hover docs, and by the auth
 * resolver for mapping operations to required Microsoft Graph scopes.
 */

import {
  type ConnectorMetadata,
  param,
  operation,
  connector,
} from '@flowforger/connectors-shared';

export const office365usersMetadata: ConnectorMetadata = connector(
  'office365users',
  'Office 365 Users',
  'Microsoft Graph connector for user profiles, manager/direct reports, search, and user photos.',
  [
    // ============= Profile =============
    operation('MyProfile_V2', 'Retrieves the profile of the current user (V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'MyProfileParams', 'Operation parameters'),
    ], { category: 'Profile', examples: [`ctx.connectors.office365users.MyProfile_V2('GetMyProfile', { $select: 'displayName,mail' });`] }),

    operation('UserProfile_V2', 'Retrieves the profile of a specific user (V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UserProfileParams', 'Operation parameters'),
    ], { category: 'Profile', examples: [`ctx.connectors.office365users.UserProfile_V2('GetUserProfile', { id: 'user@contoso.com', $select: 'displayName,jobTitle' });`] }),

    operation('Manager_V2', 'Retrieves the profile of the specified user\'s manager (V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'ManagerParams', 'Operation parameters'),
    ], { category: 'Profile' }),

    operation('DirectReports_V2', 'Retrieves the user profiles of the specified user\'s direct reports (V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'DirectReportsParams', 'Operation parameters'),
    ], { category: 'Profile' }),

    // ============= Search =============
    operation('SearchUserV2', 'Retrieves the user profiles that match the search term (V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'SearchUsersParams', 'Operation parameters'),
    ], { category: 'Search', examples: [`ctx.connectors.office365users.SearchUserV2('SearchForUsers', { searchTerm: 'jane', top: 50, isSearchTermRequired: false });`] }),

    // ============= People =============
    operation('RelevantPeople', 'Get the people most relevant to the specified user.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'RelevantPeopleParams', 'Operation parameters'),
    ], { category: 'People' }),

    // ============= Trending Documents =============
    operation('MyTrendingDocuments', 'Retrieves the trending documents for the signed in user.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'TrendingDocumentsParams', 'Operation parameters'),
    ], { category: 'Trending' }),

    operation('TrendingDocuments', 'Retrieves the trending documents for a user.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'TrendingDocumentsParams', 'Operation parameters'),
    ], { category: 'Trending' }),

    // ============= Photo =============
    operation('UserPhoto_V2', 'Retrieves the photo of the specified user if they have one (V2).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UserPhotoParams', 'Operation parameters'),
    ], { category: 'Photo' }),

    operation('UserPhotoMetadata', 'Get metadata about the specified user\'s photo.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UserPhotoMetadataParams', 'Operation parameters'),
    ], { category: 'Photo' }),

    // ============= Update =============
    operation('UpdateMyProfile', 'Updates the profile of the current user.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateMyProfileParams', 'Operation parameters'),
    ], { category: 'Update' }),

    operation('UpdateMyPhoto', 'Updates the profile photo of the current user (must be < 4 MB).', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'UpdateMyPhotoParams', 'Operation parameters'),
    ], { category: 'Update' }),

    // ============= Advanced =============
    operation('HttpRequest', 'Send a custom HTTP request to Graph API.', [
      param('actionName', 'string', 'Unique name for this action'),
      param('params', 'HttpRequestParams', 'Operation parameters'),
    ], { category: 'Advanced' }),
  ],
  {
    docsUrl: 'https://learn.microsoft.com/en-us/connectors/office365users/',
  },
);

/**
 * Maps Office 365 Users operations to their required Microsoft Graph scopes.
 * Aliases (V2 / non-V2 / lowercase) all map to the same scopes.
 */
export const office365usersScopes: Record<string, string[]> = {
  // Current user's own profile — basic read is sufficient
  MyProfile_V2: ['User.Read'], MyProfileV2: ['User.Read'], MyProfile: ['User.Read'], myProfile: ['User.Read'],

  // Reading other users' data needs directory read
  UserProfile_V2: ['User.Read.All'], UserProfileV2: ['User.Read.All'], UserProfile: ['User.Read.All'], userProfile: ['User.Read.All'],
  Manager_V2: ['User.Read.All'], ManagerV2: ['User.Read.All'], Manager: ['User.Read.All'], manager: ['User.Read.All'],
  DirectReports_V2: ['User.Read.All'], DirectReportsV2: ['User.Read.All'], DirectReports: ['User.Read.All'], directReports: ['User.Read.All'],
  SearchUserV2: ['User.Read.All'], SearchUser_V2: ['User.Read.All'], SearchUser: ['User.Read.All'], searchUser: ['User.Read.All'],
  UserPhoto_V2: ['User.Read.All'], UserPhotoV2: ['User.Read.All'], UserPhoto: ['User.Read.All'], userPhoto: ['User.Read.All'],
  UserPhotoMetadata: ['User.Read.All'], userPhotoMetadata: ['User.Read.All'],

  // People insights
  RelevantPeople: ['People.Read'], relevantPeople: ['People.Read'],

  // Trending documents need Sites scope
  MyTrendingDocuments: ['Sites.Read.All'], myTrendingDocuments: ['Sites.Read.All'],
  TrendingDocuments: ['Sites.Read.All'], trendingDocuments: ['Sites.Read.All'],

  // Writes
  UpdateMyProfile: ['User.ReadWrite'], updateMyProfile: ['User.ReadWrite'],
  UpdateMyPhoto: ['User.ReadWrite'], updateMyPhoto: ['User.ReadWrite'],

  // Generic HTTP — fall back to User.Read; caller can request additional scopes explicitly
  HttpRequest: ['User.Read'], httpRequest: ['User.Read'],
};

export default office365usersMetadata;
