import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { TeacherView } from "../components/TeacherView";

export const teacherRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/teacher",
  component: TeacherView,
});
