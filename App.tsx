import React, { useEffect, useState } from "react";
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import type { Session } from "@supabase/supabase-js";

import { supabase } from "./src/lib/supabase";
import SignInScreen from "./src/screens/SignInScreen";
import BrainDumpScreen from "./src/screens/BrainDumpScreen";
import GoalsScreen from "./src/screens/GoalsScreen";
import FocusScreen from "./src/screens/FocusScreen";
import ProgressScreen from "./src/screens/ProgressScreen";

const Tab = createBottomTabNavigator();

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Restore a persisted session on cold start...
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setChecking(false);
    });

    // ...then follow sign-in / sign-out / token-refresh from one place.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  if (checking) {
    return (
      <SafeAreaProvider>
        <View style={styles.centered}>
          <ActivityIndicator />
        </View>
        <StatusBar style="auto" />
      </SafeAreaProvider>
    );
  }

  if (!session) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
          <SignInScreen />
        </SafeAreaView>
        <StatusBar style="auto" />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.container} edges={["top", "left", "right"]}>
        <View style={styles.header}>
          <Text style={styles.email} numberOfLines={1}>
            {session.user.email}
          </Text>
          <Pressable onPress={() => supabase.auth.signOut()} hitSlop={8}>
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>
        <NavigationContainer>
          <Tab.Navigator
            screenOptions={{
              headerShown: false,
              tabBarActiveTintColor: "#3060d0",
              tabBarInactiveTintColor: "#888",
              tabBarLabelStyle: { fontSize: 13, fontWeight: "600" },
            }}
          >
            {/* Focus first: "what should I do now" is the question the app
                exists to answer. Goals and Brain Dump are the supporting acts. */}
            <Tab.Screen name="Focus" component={FocusScreen} />
            <Tab.Screen name="Progress" component={ProgressScreen} />
            <Tab.Screen name="Goals" component={GoalsScreen} />
            <Tab.Screen name="Brain Dump" component={BrainDumpScreen} />
          </Tab.Navigator>
        </NavigationContainer>
      </SafeAreaView>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#eee",
  },
  email: { color: "#666", fontSize: 13, flexShrink: 1, marginRight: 12 },
  signOut: { color: "#3060d0", fontSize: 13, fontWeight: "600" },
});
