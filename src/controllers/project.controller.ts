import { Request, Response } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { ProjectService } from '../services/project.service';
import { ResponseBuilder } from '../utils/response-builder';
import { ErrorCode } from '../types/error-dtos';

const projectService = new ProjectService();

// --- Validation Middleware ---

export const createProjectValidation = [
  body('title').isString().isLength({ min: 5, max: 200 }).withMessage('Title required (5-200 chars).').bail(),
  body('description').optional().isString().isLength({ max: 2000 }).withMessage('Description max 2000 chars.'),
  body('category').isString().isLength({ min: 1, max: 100 }).withMessage('Category is required.'),
  body('visibility').optional().isIn(['public', 'private']).withMessage('Visibility must be public or private.'),
  body('collaborationType').optional().isIn(['open', 'invite']).withMessage('Collaboration type must be open or invite.'),
  body('roles').isArray({ min: 1 }).withMessage('At least one role must be defined.'),
  body('roles.*.title').isString().withMessage('Role title is required.'),
  body('roles.*.slots').isInt({ min: 1, max: 50 }).withMessage('Role slots must be between 1 and 50.'),
  body('roles.*.description').optional().isString().isLength({ max: 500 }).withMessage('Role description max 500 chars.'),
  body('roles.*.requiredSkills').optional().isArray().withMessage('Required skills must be an array.'),
  body('roles.*.requiredSkills.*').optional().isString().isLength({ max: 50 }).withMessage('Skill max 50 chars.'),
  body('revenueModel').isObject().withMessage('Revenue model is required.'),
  body('revenueModel.splits').isArray({ min: 1 }).withMessage('At least one revenue split is required.'),
  body('revenueModel.splits.*.placeholder').optional().isString().isLength({ max: 100 }).withMessage('Placeholder max 100 chars.'),
  body('revenueModel.splits.*.percentage').optional().isFloat({ min: 0, max: 100 }).withMessage('Percentage must be 0-100.'),
  body('revenueModel.splits.*.fixedAmount').optional().isFloat({ min: 0 }).withMessage('Fixed amount must be >= 0.'),
  body('milestones').optional().isArray().withMessage('Milestones must be an array.'),
  body('milestones.*.title').optional().isString().isLength({ min: 1, max: 200 }).withMessage('Milestone title required.'),
  body('milestones.*.description').optional().isString().isLength({ max: 1000 }).withMessage('Milestone description max 1000 chars.'),
  body('milestones.*.dueDate').optional().isISO8601().withMessage('Due date must be valid ISO 8601.'),
  body('milestones.*.amount').optional().isFloat({ min: 0 }).withMessage('Milestone amount must be >= 0.'),
  body('milestones.*.currency').optional().isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be 3 chars.'),
];

/** Handles project creation from the 6-step wizard payload. POST /projects */
export const createProjectController = async (req: Request, res: Response): Promise<void> => {
  // 1. Input Validation
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const ownerId = req.user?.sub; // Authenticated user ID
  if (!ownerId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    // 2. Service Call
    const createdProject = await projectService.createProject(ownerId, req.body);

    // 3. Success (201 Created)
    return ResponseBuilder.success(
      res,
      {
        projectId: createdProject._id?.toString(),
        ownerId: createdProject.ownerId.toString(),
        status: createdProject.status,
        createdAt: createdProject.createdAt?.toISOString(),
        message: 'Project created successfully in draft mode.',
      },
      201
    );
  } catch (error: unknown) {
    // 4. Error Handling: Catch Mongoose custom validation error from pre-save hook
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (error instanceof Error && error.name === 'ValidatorError' && errorMessage.includes('Revenue splits must sum to 100%')) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, errorMessage, 422);
    }

    if (errorMessage.includes('Revenue splits must sum to 100%')) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, errorMessage, 422);
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during project creation.',
      500
    );
  }
};

// --- Member Management Validation ---

export const projectAndRoleParamValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  param('roleId').isMongoId().withMessage('Invalid Role ID format.').bail(),
];

export const inviteValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  body('userId').isMongoId().withMessage('Target User ID is required and must be valid Mongo ID.'),
  body('roleId').isMongoId().withMessage('Role ID is required and must be valid Mongo ID.'),
  body('message').optional().isString().isLength({ max: 500 }).withMessage('Message max 500 chars.'),
];

export const applyValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  body('roleId').isMongoId().withMessage('Role ID is required and must be valid Mongo ID.'),
  body('message').optional().isString().isLength({ max: 1000 }).withMessage('Message max 1000 chars.'),
  body('proposedRate').optional().isInt({ min: 0 }).toInt().withMessage('Proposed rate must be >= 0.'),
];

export const assignValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  param('roleId').isMongoId().withMessage('Invalid Role ID format.').bail(),
  body('userId').isMongoId().withMessage('Target User ID is required and must be valid Mongo ID.'),
];

// --- Member Management Controllers ---

/** Handles owner inviting a user. POST /projects/:projectId/invite */
export const inviteUserController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId } = req.params;
    const { userId: targetUserId, roleId, message } = req.body;

    if (!projectId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID is required', 400);
    }

    const invite = await projectService.inviteUser(
      projectId, 
      requesterId, 
      targetUserId, 
      roleId, 
      message, 
      requesterRole
    );

    return ResponseBuilder.success(
      res,
      {
        inviteId: invite._id?.toString(),
        projectId,
        roleId,
        status: invite.status,
        invitedUserId: invite.invitedUserId.toString(),
        message: 'Invitation sent successfully.',
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'Only the project owner can send invitations.', 403);
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }
    if (errorMessage === 'RoleNotFound') {
      return ResponseBuilder.notFound(res, 'Role');
    }
    if (errorMessage === 'RoleFull') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'The specified role has no available slots.', 409);
    }
    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.notFound(res, 'User');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error during invite.', 500);
  }
};

/** Handles user applying for a role. POST /projects/:projectId/apply */
export const applyForRoleController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const applicantId = req.user?.sub;
  if (!applicantId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId } = req.params;
    const { roleId, message, proposedRate } = req.body;

    if (!projectId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID is required', 400);
    }

    const application = await projectService.applyForRole(projectId, applicantId, roleId, message, proposedRate);

    return ResponseBuilder.success(
      res,
      {
        applicationId: application._id?.toString(),
        projectId,
        roleId,
        applicantId,
        status: application.status,
        appliedAt: application.createdAt?.toISOString(),
        message: 'Application submitted successfully.',
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }
    if (errorMessage === 'ProjectNotOpen') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'This project does not accept open applications.', 403);
    }
    if (errorMessage === 'RoleNotFound') {
      return ResponseBuilder.notFound(res, 'Role');
    }
    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.notFound(res, 'User');
    }

    // Handle duplicate application (unique index violation)
    if ((error as any).code === 11000) {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'You have already applied for this role.', 409);
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error during application.', 500);
  }
};

/** Handles owner assigning an applicant/invitee to a role. POST /projects/:projectId/roles/:roleId/assign */
export const assignRoleController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId, roleId } = req.params;
    const { userId: targetUserId } = req.body;

    if (!projectId || !roleId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID and Role ID are required', 400);
    }

    // Service handles capacity check and atomic DB update
    const updatedProject = await projectService.assignRole(
      projectId, 
      requesterId, 
      targetUserId, 
      roleId, 
      requesterRole
    );
    const assignedRole = updatedProject.roles.find(r => r._id?.toString() === roleId);

    return ResponseBuilder.success(
      res,
      {
        roleId,
        assignedUserIds: assignedRole?.assignedUserIds.map(id => id.toString()) || [],
        filled: assignedRole?.assignedUserIds.length || 0,
        slots: assignedRole?.slots || 0,
        message: `User ${targetUserId} successfully assigned to role.`,
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'Only the project owner can assign roles.', 403);
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }
    if (errorMessage === 'RoleNotFound') {
      return ResponseBuilder.notFound(res, 'Role');
    }
    if (errorMessage === 'RoleFull') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'Cannot assign; the role slots are full.', 409);
    }
    if (errorMessage === 'AlreadyAssigned') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'User is already assigned to this role.', 409);
    }
    if (errorMessage === 'UserNotFound') {
      return ResponseBuilder.notFound(res, 'User');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error during role assignment.', 500);
  }
};

// --- Milestone Management Validation ---

export const milestoneParamValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  param('milestoneId').isMongoId().withMessage('Invalid Milestone ID format.').bail(),
];

export const addMilestoneValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
  body('title').isString().isLength({ min: 3, max: 200 }).withMessage('Milestone title required (3-200 chars).'),
  body('description').optional().isString().isLength({ max: 1000 }).withMessage('Description max 1000 chars.'),
  body('amount').isInt({ min: 0 }).toInt().withMessage('Amount must be a non-negative integer (cents).'),
  body('currency').optional().isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be 3 chars.'),
  body('dueDate').optional().isISO8601().toDate().withMessage('Due date must be a valid ISO 8601 date.'),
];

export const updateMilestoneValidation = [
  ...milestoneParamValidation,
  body('title').optional().isString().isLength({ min: 3, max: 200 }).withMessage('Title 3-200 chars.'),
  body('description').optional().isString().isLength({ max: 1000 }).withMessage('Description max 1000 chars.'),
  body('amount').optional().isInt({ min: 0 }).toInt().withMessage('Amount must be >= 0.'),
  body('currency').optional().isString().isLength({ min: 3, max: 3 }).withMessage('Currency must be 3 chars.'),
  body('dueDate').optional().isISO8601().toDate().withMessage('Due date must be valid ISO 8601.'),
];

export const completeMilestoneValidation = [
  ...milestoneParamValidation,
  body('notes').optional().isString().isLength({ max: 2000 }).withMessage('Notes max 2000 chars.'),
  body('evidenceAssetIds').optional().isArray().withMessage('Evidence asset IDs must be an array.'),
  body('evidenceAssetIds.*').optional().isMongoId().withMessage('Evidence asset ID must be valid Mongo ID.'),
];

// --- Milestone Controllers ---

/** Adds a new milestone. POST /projects/:projectId/milestones */
export const addMilestoneController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId } = req.params;
    if (!projectId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID is required', 400);
    }

    const newMilestone = await projectService.addMilestone(projectId, requesterId, req.body, requesterRole);

    return ResponseBuilder.success(
      res,
      {
        milestoneId: newMilestone._id.toString(),
        title: newMilestone.title,
        amount: newMilestone.amount,
        currency: newMilestone.currency,
        status: newMilestone.status,
        createdAt: new Date().toISOString(), // newMilestone doesn't have timestamps yet
        message: 'Milestone created successfully.',
      },
      201
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'Only the project owner can add milestones.', 403);
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error adding milestone.', 500);
  }
};

/** Updates an existing milestone. PUT /projects/:projectId/milestones/:milestoneId */
export const updateMilestoneController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId, milestoneId } = req.params;
    if (!projectId || !milestoneId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID and Milestone ID are required', 400);
    }

    const updatedMilestone = await projectService.updateMilestone(projectId, requesterId, milestoneId, req.body, requesterRole);

    return ResponseBuilder.success(
      res,
      {
        milestoneId: updatedMilestone._id.toString(),
        title: updatedMilestone.title,
        description: updatedMilestone.description,
        amount: updatedMilestone.amount,
        currency: updatedMilestone.currency,
        status: updatedMilestone.status,
        dueDate: updatedMilestone.dueDate?.toISOString(),
        message: 'Milestone updated successfully.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'MilestoneFundedConflict') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'Cannot modify amount/currency of an already funded milestone.', 409);
    }
    if (errorMessage === 'MilestoneNotFound') {
      return ResponseBuilder.notFound(res, 'Milestone');
    }
    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'Only the project owner can update milestones.', 403);
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error updating milestone.', 500);
  }
};

/** Deletes an existing milestone. DELETE /projects/:projectId/milestones/:milestoneId */
export const deleteMilestoneController = async (req: Request, res: Response): Promise<void> => {
  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId, milestoneId } = req.params;
    if (!projectId || !milestoneId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID and Milestone ID are required', 400);
    }

    await projectService.deleteMilestone(projectId, requesterId, milestoneId, requesterRole);

    return ResponseBuilder.success(res, {}, 204);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'MilestoneFundedConflict') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'Cannot delete a milestone with associated funds/escrow.', 409);
    }
    if (errorMessage === 'MilestoneNotFound') {
      return ResponseBuilder.notFound(res, 'Milestone');
    }
    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'Only the project owner can delete milestones.', 403);
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error deleting milestone.', 500);
  }
};

/** Marks a milestone as completed. POST /projects/:projectId/milestones/:milestoneId/complete */
export const completeMilestoneController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const completerId = req.user?.sub;
  if (!completerId) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId, milestoneId } = req.params;
    if (!projectId || !milestoneId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID and Milestone ID are required', 400);
    }

    const { notes, evidenceAssetIds } = req.body;

    const updatedMilestone = await projectService.completeMilestone(projectId, milestoneId, completerId, notes, evidenceAssetIds);

    return ResponseBuilder.success(
      res,
      {
        milestoneId: updatedMilestone._id.toString(),
        status: updatedMilestone.status,
        completedBy: completerId,
        title: updatedMilestone.title,
        amount: updatedMilestone.amount,
        currency: updatedMilestone.currency,
        message: 'Milestone marked as complete, awaiting owner approval.',
      },
      200
    );
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'Only a project member can complete milestones.', 403);
    }
    if (errorMessage === 'MilestoneAlreadyProcessed') {
      return ResponseBuilder.error(res, ErrorCode.CONFLICT, 'Milestone is already completed or approved.', 409);
    }
    if (errorMessage === 'MilestoneNotFound') {
      return ResponseBuilder.notFound(res, 'Milestone');
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error completing milestone.', 500);
  }
};

// --- Project Read/List/Update Controllers ---

export const projectParamValidation = [
  param('projectId').isMongoId().withMessage('Invalid Project ID format.').bail(),
];

export const listProjectsValidation = [
  query('status').optional().isIn(['draft', 'active', 'paused', 'completed', 'archived']).withMessage('Invalid status.'),
  query('ownerId').optional().isMongoId().withMessage('Owner ID must be valid Mongo ID.'),
  query('page').optional().isInt({ min: 1 }).toInt().withMessage('Page must be a positive integer.'),
  query('per_page').optional().isInt({ min: 1, max: 100 }).toInt().withMessage('Per_page must be between 1 and 100.'),
];

export const updateProjectValidation = [
  ...projectParamValidation,
  body('title').optional().isString().isLength({ min: 5, max: 200 }).withMessage('Title 5-200 chars.'),
  body('description').optional().isString().isLength({ max: 2000 }).withMessage('Description max 2000 chars.'),
  body('category').optional().isString().isLength({ min: 1, max: 100 }).withMessage('Category 1-100 chars.'),
  body('visibility').optional().isIn(['public', 'private']).withMessage('Visibility must be public or private.'),
  body('status').optional().isIn(['draft', 'active', 'paused', 'completed', 'archived']).withMessage('Invalid status.'),
];

/** Lists projects. GET /projects */
export const listProjectsController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  try {
    const requesterId = req.user?.sub; // May be undefined if anonymous access
    const list = await projectService.listProjects(requesterId, req.query);

    return ResponseBuilder.success(res, list, 200);
  } catch (error: unknown) {
    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error listing projects.', 500);
  }
};

/** Gets project details. GET /projects/:projectId */
export const getProjectDetailsController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  try {
    const { projectId } = req.params;
    if (!projectId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID is required', 400);
    }

    const requesterId = req.user?.sub;
    const requesterRole = req.user?.role;

    const projectDetails = await projectService.getProjectDetails(projectId, requesterId, requesterRole);

    return ResponseBuilder.success(res, projectDetails, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'ProjectNotFound' || errorMessage === 'PermissionDenied') {
      // Return 404 for access denied on private projects (security)
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error fetching project details.', 500);
  }
};

/** Updates the main project document. PUT /projects/:projectId */
export const updateProjectController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId } = req.params;
    if (!projectId) {
      return ResponseBuilder.error(res, ErrorCode.VALIDATION_ERROR, 'Project ID is required', 400);
    }

    const updatedProject = await projectService.updateProject(projectId, requesterId, req.body, requesterRole);

    return ResponseBuilder.success(res, updatedProject, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(res, ErrorCode.PERMISSION_DENIED, 'Only the project owner can update the project.', 403);
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(res, ErrorCode.INTERNAL_SERVER_ERROR, 'Internal server error updating project.', 500);
  }
};

// --- Final Project Mutators/Readers (Task 29) ---

/** Archives a project (soft delete). DELETE /projects/:projectId */
export const archiveProjectController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId } = req.params as { projectId: string };

    await projectService.archiveProject(projectId, requesterId, requesterRole);

    return ResponseBuilder.noContent(res); // 204 No Content on successful archiving
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'Only the project owner or an Admin can archive this project.',
        403
      );
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }
    if (errorMessage === 'ActiveEscrowConflict') {
      return ResponseBuilder.error(
        res,
        ErrorCode.CONFLICT,
        'Project cannot be archived due to active escrow funds.',
        409
      );
    }
    if (errorMessage === 'ArchiveFailed') {
      return ResponseBuilder.error(
        res,
        ErrorCode.INTERNAL_SERVER_ERROR,
        'Failed to archive project.',
        500
      );
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error during archiving.',
      500
    );
  }
};

/** Retrieves the denormalized team list. GET /projects/:projectId/team */
export const getTeamMembersController = async (req: Request, res: Response): Promise<void> => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return ResponseBuilder.validationError(
      res,
      errors.array().map(err => ({
        field: err.type === 'field' ? (err as any).path : undefined,
        reason: err.msg,
        value: err.type === 'field' ? (err as any).value : undefined,
      }))
    );
  }

  const requesterId = req.user?.sub;
  const requesterRole = req.user?.role;
  if (!requesterId || !requesterRole) {
    return ResponseBuilder.unauthorized(res, 'Authentication required');
  }

  try {
    const { projectId } = req.params as { projectId: string };

    const teamDetails = await projectService.getTeamMembers(projectId, requesterId, requesterRole);

    return ResponseBuilder.success(res, teamDetails, 200);
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage === 'PermissionDenied') {
      return ResponseBuilder.error(
        res,
        ErrorCode.PERMISSION_DENIED,
        'You must be a project member to view the team list.',
        403
      );
    }
    if (errorMessage === 'ProjectNotFound') {
      return ResponseBuilder.notFound(res, 'Project');
    }

    return ResponseBuilder.error(
      res,
      ErrorCode.INTERNAL_SERVER_ERROR,
      'Internal server error retrieving team list.',
      500
    );
  }
};
