import { call as invoke } from "@/lib/desktop/review.commands"
import type {
  OnboardingTour,
  CurrentTourStep,
  TourImportReport,
} from "@/lib/desktop/contracts.generated"
export const onboardingCommands = {
  list: (repositoryId: string) =>
    invoke<OnboardingTour[]>("list_onboarding_tours", { repositoryId }),
  save: (tour: OnboardingTour) =>
    invoke<OnboardingTour>("save_onboarding_tour", { tour }),
  read: (tourId: string, stepId: string) =>
    invoke<CurrentTourStep>("read_onboarding_step", { tourId, stepId }),
  import: (repositoryId: string) =>
    invoke<TourImportReport | null>("import_onboarding_tour", { repositoryId }),
  export: (id: string) => invoke<boolean>("export_onboarding_tour", { id }),
}
