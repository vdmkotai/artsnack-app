"use client";

import * as React from "react";
import { Check, ChevronsUpDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Drawer, DrawerContent, DrawerTrigger } from "@/components/ui/drawer";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMediaQuery } from "@/hooks/use-media-query";

type Option = {
  label: string;
  value: string;
  description?: string;
  /** A section heading; options sharing one are listed under it, in order of first appearance. */
  group?: string;
};

export interface SearchableSelectProps {
  /** Options can be either objects with label/value or simple strings */
  options: Option[] | string[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  className?: string;
}

function normalizeOptions(options: Option[] | string[]): Option[] {
  if (options.length === 0) return [];
  if (typeof options[0] === "string") {
    return (options as string[]).map((opt) => ({ label: opt, value: opt }));
  }
  return options as Option[];
}

function groupOptions(options: Option[]): { heading?: string; options: Option[] }[] {
  const groups = new Map<string | undefined, Option[]>();
  for (const option of options) {
    const group = groups.get(option.group);
    if (group) group.push(option);
    else groups.set(option.group, [option]);
  }
  return [...groups].map(([heading, grouped]) => ({ heading, options: grouped }));
}

export function SearchableSelect({
  options: rawOptions,
  value,
  onValueChange,
  placeholder = "Select option...",
  emptyMessage = "No option found.",
  disabled = false,
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false);
  // A combobox has to name the popup it controls, and the popup only exists
  // while it is open.
  const listId = React.useId();
  const isDesktopQuery = useMediaQuery("(min-width: 768px)");
  // Default to desktop during SSR to prevent hydration mismatch
  const isDesktop = isDesktopQuery ?? true;

  const options = React.useMemo(() => normalizeOptions(rawOptions), [rawOptions]);
  const groups = React.useMemo(() => groupOptions(options), [options]);
  const selectedOption = options.find((option) => option.value === value);
  const selectedLabel = selectedOption?.label ?? value ?? placeholder;
  const selectedDescription = selectedOption?.description;

  const optionContent = (option: Option) => (
    <>
      <Check
        className={cn(
          "mr-1 h-4 w-4 self-start",
          value === option.value ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="min-w-0 text-left">
        <span className="block truncate" title={option.label}>
          {option.label}
        </span>
        {option.description && (
          <span className="block truncate text-[10px] font-normal text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
    </>
  );

  // The value is what cmdk filters on and tells rows apart by, so it carries
  // the option's own value too: two options may share a label and a line.
  const optionGroups = groups.map((group) => (
    <CommandGroup key={group.heading ?? ""} heading={group.heading}>
      {group.options.map((option) => (
        <CommandItem
          key={option.value}
          value={`${option.label} ${option.description ?? ""} ${option.value}`}
          className={option.description ? "items-start py-2" : undefined}
          onSelect={() => {
            onValueChange(option.value);
            setOpen(false);
          }}
        >
          {optionContent(option)}
        </CommandItem>
      ))}
    </CommandGroup>
  ));

  if (isDesktop) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              className={cn(
                "w-full justify-between",
                selectedDescription && "h-auto min-h-10 py-1.5",
                className,
              )}
              disabled={disabled}
            />
          }
        >
          <span className="min-w-0 text-left">
            <span className="block truncate">{selectedLabel}</span>
            {selectedDescription && (
              <span className="block truncate text-[10px] font-normal text-muted-foreground">
                {selectedDescription}
              </span>
            )}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        {/* --anchor-width is Base UI's equivalent of Radix's
            --radix-popover-trigger-width: set on the Positioner, inherited by
            the Popup this className lands on. The list must match the trigger. */}
        <PopoverContent id={listId} className="w-(--anchor-width) p-0" align="start">
          <Command>
            <CommandInput placeholder={`Search ${placeholder.toLowerCase()}...`} />
            <CommandList className="max-h-[min(50vh,300px)] overflow-y-auto">
              <CommandEmpty>{emptyMessage}</CommandEmpty>
              {optionGroups}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            className={cn(
              "w-full justify-between",
              selectedDescription && "h-auto min-h-10 py-1.5",
              className,
            )}
            disabled={disabled}
          />
        }
      >
        <span className="min-w-0 text-left">
          <span className="block truncate">{selectedLabel}</span>
          {selectedDescription && (
            <span className="block truncate text-[10px] font-normal text-muted-foreground">
              {selectedDescription}
            </span>
          )}
        </span>
        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
      </DrawerTrigger>
      <DrawerContent id={listId}>
        <div className="mt-4 border-t">
          <Command>
            <CommandInput placeholder={`Search ${placeholder.toLowerCase()}...`} />
            <CommandList className="max-h-[50vh] overflow-y-auto">
              <CommandEmpty>{emptyMessage}</CommandEmpty>
              {optionGroups}
            </CommandList>
          </Command>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
