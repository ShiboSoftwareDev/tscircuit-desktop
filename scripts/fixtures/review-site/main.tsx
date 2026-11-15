import "@fontsource-variable/inter"
import "./styles.css"
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { Button } from "~/components/ui/button"
import { AddChipDialog, buildAddChipPrompt } from "~/tscircuit/AddChipDialog"

function ReviewSite() {
  const [dialogOpen, setDialogOpen] = useState(true)
  const [request, setRequest] = useState("")
  const [datasheetName, setDatasheetName] = useState("")

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-5 px-6 py-10 text-foreground">
      <header className="flex items-center justify-between gap-4 border-b pb-4">
        <h1 className="text-lg font-semibold">tscircuit desktop preview</h1>
        <Button onClick={() => setDialogOpen(true)}>Add chip</Button>
      </header>
      {request && (
        <section aria-label="Generated request" className="space-y-3 text-sm">
          <h2 className="font-medium">Generated request</h2>
          {datasheetName && <p className="text-muted-foreground">{datasheetName}</p>}
          <p className="whitespace-pre-wrap rounded-lg bg-muted p-4">{request}</p>
        </section>
      )}
      {dialogOpen && (
        <AddChipDialog
          fileLimit={10 * 1024 * 1024}
          onClose={() => setDialogOpen(false)}
          onAdd={async (chip) => {
            setRequest(buildAddChipPrompt(chip))
            setDatasheetName(chip.datasheet?.name ?? "")
            setDialogOpen(false)
            return null
          }}
        />
      )}
    </main>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Missing preview root")
createRoot(root).render(<ReviewSite />)
