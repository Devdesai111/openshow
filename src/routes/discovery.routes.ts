import { Router } from 'express';
import { searchCreatorsController, searchCreatorsValidation } from '../controllers/discovery.controller';

const router = Router();

// Public Creator Directory
router.get('/creators', searchCreatorsValidation, searchCreatorsController);

export default router;


